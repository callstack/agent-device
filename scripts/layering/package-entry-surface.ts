// Catches extra package entries and star re-exports on test-kit and daemon.
//
// Part of R83 package-export-surface. The dependency, import and reference-cycle half is the
// shared walk in package-isolation.ts under TEST_KIT_ISOLATION.

import type { LayeringViolation } from './model.ts';
import { PACKAGE_EXPORT_SURFACE_RULE, TEST_KIT_PACKAGE } from './package-export-surface.ts';
import {
  checkPackageIsolation,
  TEST_KIT_ISOLATION,
  type ParsedManifests,
} from './package-isolation.ts';

const TEST_KIT_DIR = TEST_KIT_ISOLATION.dir;
const TEST_KIT_ENTRY = './src/index.ts';
const DAEMON_DIR = 'packages/daemon';
const DAEMON_PACKAGE = '@agent-device/daemon';

const ENTRY_SURFACES = [
  { packageName: TEST_KIT_PACKAGE, dir: TEST_KIT_DIR, entry: TEST_KIT_ENTRY },
  { packageName: DAEMON_PACKAGE, dir: DAEMON_DIR, entry: './src/index.ts' },
] as const;

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

function violation(file: string, message: string, line = 1): LayeringViolation {
  return { rule: PACKAGE_EXPORT_SURFACE_RULE, file, line, message };
}

/** Keeps test-kit and daemon on one named public entry; test-kit also runs the isolation walk. */
export function checkPackageEntrySurfaces(
  manifests: ParsedManifests,
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const testKitFile = `${TEST_KIT_DIR}/package.json`;
  const violations = ENTRY_SURFACES.flatMap((entrySurface) =>
    checkEntrySurface(entrySurface, manifests, sources),
  );
  if (manifests.has(testKitFile)) {
    violations.push(...checkPackageIsolation(manifests, sources, TEST_KIT_ISOLATION));
  }
  return violations;
}

function checkEntrySurface(
  entrySurface: (typeof ENTRY_SURFACES)[number],
  manifests: ParsedManifests,
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const manifestFile = `${entrySurface.dir}/package.json`;
  const manifest = manifests.get(manifestFile);
  if (!manifest) return [];

  const violations: LayeringViolation[] = [];
  const exported = (manifest.exports as Record<string, unknown> | undefined) ?? {};
  const exportKeys = Object.keys(exported);
  const entryTargets = stringLeaves(exported['.']);
  if (
    exportKeys.length !== 1 ||
    exportKeys[0] !== '.' ||
    entryTargets.length === 0 ||
    entryTargets.some((target) => target !== entrySurface.entry)
  ) {
    violations.push(
      violation(
        manifestFile,
        `${entrySurface.packageName} exports exactly "." and every condition of it is ` +
          `${entrySurface.entry} (found ${exportKeys.join(', ') || 'none'} -> ` +
          `${entryTargets.join(', ') || 'nothing'}).`,
      ),
    );
  }

  const entryFile = `${entrySurface.dir}/src/index.ts`;
  const entrySource = sources.get(entryFile);
  const starExport = entrySource === undefined ? null : /^[ \t]*export\s*\*/m.exec(entrySource);
  if (entrySource !== undefined && starExport) {
    const line = entrySource.slice(0, starExport.index).split('\n').length;
    violations.push(
      violation(
        entryFile,
        `${entrySurface.packageName} names every export explicitly: \`export *\` is forbidden.`,
        line,
      ),
    );
  }
  return violations;
}
