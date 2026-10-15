// Catches: `@agent-device/test-kit` growing a dependency on the code it exists to test, or a
//   package it builds on declaring it back. test-kit is the one home of test helpers shared across
//   packages, so it may build only on the packages below the ones that consume it. A fixture that
//   needs a platform, provider, daemon or root module's code is a test of that package and belongs
//   in it; and TypeScript project references are acyclic, so a package test-kit reaches (directly or
//   through other packages) cannot declare test-kit and keeps its helpers beside its tests.
// Evidence: the single-entry test-kit loads every helper eagerly, so one platform import would put
//   that platform's closure into every test's import graph, and a package test-kit builds on that
//   declared test-kit would close a reference cycle `tsc -b` rejects.
// Cost: one pass over the tracked manifests and test-kit's sources.
// Kill criterion: a maintainer decision that test-kit may depend on platform, provider, daemon or
//   root code.
//
// Part of R83 package-export-surface. The forbidden set is derived from the workspace layout, not
// from name patterns: every package under `packages/platform-*` or `packages/provider-*` (whatever
// name it publishes, e.g. `@agent-device/testmu`), the daemon package, and the root package.

import path from 'node:path';
import type { LayeringViolation } from './model.ts';
import { specifierSites } from './package-boundaries.ts';
import { PACKAGE_EXPORT_SURFACE_RULE, TEST_KIT_PACKAGE } from './package-export-surface.ts';

const TEST_KIT_DIR = 'packages/test-kit';
const TEST_KIT_ENTRY = './src/index.ts';
const ROOT_PACKAGE = 'agent-device';
const FORBIDDEN_PACKAGE_DIR = /^packages\/(?:platform-[^/]+|provider-[^/]+|daemon)\/package\.json$/;

type DependencyManifest = {
  name?: string;
  exports?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

/** Every package name a manifest declares in any dependency field. */
function declaredNames(manifest: DependencyManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

function violation(file: string, message: string, line = 1): LayeringViolation {
  return { rule: PACKAGE_EXPORT_SURFACE_RULE, file, line, message };
}

/** The package names test-kit may not build on, from the workspace layout. */
function forbiddenNames(parsed: ReadonlyMap<string, DependencyManifest>): Set<string> {
  const names = new Set([ROOT_PACKAGE]);
  for (const [file, manifest] of parsed) {
    if (FORBIDDEN_PACKAGE_DIR.test(file) && manifest.name) names.add(manifest.name);
  }
  return names;
}

function isForbiddenSpecifier(specifier: string, forbidden: ReadonlySet<string>): boolean {
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
  return forbidden.has(name);
}

/**
 * The shape of the one shared test package: a single `.` entry; no dependency, direct or through
 * other workspace packages, on a platform, provider, daemon or root package; no import of one or
 * relative reach out of its directory (the shared import walk, so `vi.mock` literals count); and no
 * package it reaches declaring it back.
 */
export function checkTestKitIsolation(
  manifests: ReadonlyMap<string, string>,
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const parsed = new Map<string, DependencyManifest>();
  for (const [file, text] of manifests) parsed.set(file, JSON.parse(text) as DependencyManifest);
  const testKitFile = `${TEST_KIT_DIR}/package.json`;
  const testKit = parsed.get(testKitFile);
  if (!testKit) return violations;

  const exported = (testKit.exports as Record<string, unknown> | undefined) ?? {};
  const exportKeys = Object.keys(exported);
  const entryTargets = stringLeaves(exported['.']);
  if (
    exportKeys.length !== 1 ||
    exportKeys[0] !== '.' ||
    entryTargets.length === 0 ||
    entryTargets.some((target) => target !== TEST_KIT_ENTRY)
  ) {
    violations.push(
      violation(
        testKitFile,
        `${TEST_KIT_PACKAGE} exports exactly "." and every condition of it is ${TEST_KIT_ENTRY} ` +
          `(found ${exportKeys.join(', ') || 'none'} -> ${entryTargets.join(', ') || 'nothing'}): a ` +
          `shared helper is a named export of src/index.ts, not a subpath.`,
      ),
    );
  }

  const fileByName = new Map<string, string>();
  for (const [file, manifest] of parsed) if (manifest.name) fileByName.set(manifest.name, file);
  const forbidden = forbiddenNames(parsed);

  // Breadth-first over the workspace dependency graph from test-kit; `via` is the path to a package.
  const via = new Map<string, string[]>([[TEST_KIT_PACKAGE, [TEST_KIT_PACKAGE]]]);
  const queue = [TEST_KIT_PACKAGE];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const manifest = parsed.get(fileByName.get(current) ?? '');
    if (!manifest) continue;
    for (const name of declaredNames(manifest)) {
      const chain = [...via.get(current)!, name];
      if (name === TEST_KIT_PACKAGE && current !== TEST_KIT_PACKAGE) {
        violations.push(
          violation(
            fileByName.get(current)!,
            `${chain.join(' -> ')} closes a project-reference cycle: keep '${current}' test helpers ` +
              `beside its tests.`,
          ),
        );
        continue;
      }
      if (forbidden.has(name)) {
        violations.push(
          violation(
            testKitFile,
            `${chain.join(' -> ')}: ${TEST_KIT_PACKAGE} builds on a platform, provider, daemon or root ` +
              `package. A fixture that needs that code is a test of that package and belongs in it.`,
          ),
        );
        continue;
      }
      if (!fileByName.has(name) || via.has(name)) continue;
      via.set(name, chain);
      queue.push(name);
    }
  }

  const entrySource = sources.get(`${TEST_KIT_DIR}/src/index.ts`);
  const starExport = entrySource === undefined ? null : /^[ \t]*export\s*\*/m.exec(entrySource);
  if (entrySource !== undefined && starExport) {
    const line = entrySource.slice(0, starExport.index).split('\n').length;
    violations.push(
      violation(
        `${TEST_KIT_DIR}/src/index.ts`,
        `${TEST_KIT_PACKAGE} names every export explicitly: \`export *\` would publish a module's whole surface.`,
        line,
      ),
    );
  }

  for (const [file, source] of sources) {
    if (!file.startsWith(`${TEST_KIT_DIR}/`)) continue;
    for (const site of specifierSites(file, source)) {
      const escapes =
        site.specifier.startsWith('.') &&
        !path.posix.join(path.posix.dirname(file), site.specifier).startsWith(`${TEST_KIT_DIR}/`);
      if (!escapes && !isForbiddenSpecifier(site.specifier, forbidden)) continue;
      violations.push(
        violation(
          file,
          `${TEST_KIT_PACKAGE} imports '${site.specifier}'. It may build only on the packages ` +
            `below it, never on a platform, provider, daemon or root module.`,
          site.line,
        ),
      );
    }
  }
  return violations;
}
