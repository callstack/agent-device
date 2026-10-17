// Catches: a pinned package entry growing a sibling subpath, pointing somewhere other than its
//   declared entry file, or re-exporting a module's whole surface with `export *`. test-kit is the
//   one home of test helpers shared across packages, so a second entry there publishes a fixture's
//   surface into every test's import graph. The daemon's entry is its package boundary and the one
//   place a barrel is allowed, so a subpath or a star re-export there publishes the daemon graph
//   under an unowned name (ADR 0033).
// Evidence: both packages held the shape by hand until now; test-kit's single entry and the
//   daemon's `.` are each asserted by the same declaration.
// Cost: one pass over the pinned manifests and their entry sources.
// Kill criterion: a maintainer decision that a pinned package may expose subpath entries or a star
//   re-export from its entry.
//
// Part of R83 package-export-surface. The dependency, import and reference-cycle half is the
// shared walk in package-isolation.ts under TEST_KIT_ISOLATION.

import { parseSync } from 'oxc-parser';
import { visitAst } from './layering-ast.ts';
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
  const starLine = entrySource === undefined ? null : findStarExportLine(entryFile, entrySource);
  if (starLine !== null) {
    violations.push(
      violation(
        entryFile,
        `${entrySurface.packageName} names every export explicitly: \`export *\` is forbidden.`,
        starLine,
      ),
    );
  }
  return violations;
}

/**
 * The line of the first star re-export in an entry's source, or null when it names everything.
 * Read as syntax rather than text, for the reason `facade-exports.ts` records from #1555: a form
 * scanner has to enumerate every export FORM by hand and the one it forgets slips through.
 * `ExportAllDeclaration` is the one node every star shape builds — `export *`, `export * as ns`,
 * and their `export type` forms, which publish a module's surface under one or zero names — while a
 * comment or template literal that merely mentions a star declares no node at all.
 */
function findStarExportLine(entryFile: string, source: string): number | null {
  let start: number | null = null;
  visitAst(parseSync(entryFile, source).program, (node) => {
    if (start === null && node.type === 'ExportAllDeclaration' && typeof node.start === 'number') {
      start = node.start;
    }
  });
  return start === null ? null : source.slice(0, start).split('\n').length;
}
