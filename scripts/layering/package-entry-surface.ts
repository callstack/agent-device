// Catches: `@agent-device/test-kit` growing a second entry, a star re-export, or a dependency on
//   the code it exists to test. test-kit is the one home of test helpers shared across packages and
//   every helper is a named export of its single entry, so a fixture that needs a platform,
//   provider, daemon or root module's code is a test of that package and belongs in it.
// Evidence: the single-entry test-kit loads every helper eagerly, so a second entry or a star
//   re-export would publish a module's whole surface into every test's import graph.
// Cost: one pass over the tracked manifests and test-kit's entry.
// Kill criterion: a maintainer decision that test-kit may expose subpath entries or depend on
//   platform, provider, daemon or root code.
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

function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
}

function violation(file: string, message: string, line = 1): LayeringViolation {
  return { rule: PACKAGE_EXPORT_SURFACE_RULE, file, line, message };
}

/**
 * The shape of the one shared test package: a single `.` entry that names its exports, plus the
 * shared isolation walk (no platform, provider, daemon or root package reached directly, through
 * other packages or by import; no package it reaches declaring it back).
 */
export function checkTestKitIsolation(
  manifests: ParsedManifests,
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const testKitFile = `${TEST_KIT_DIR}/package.json`;
  const testKit = manifests.get(testKitFile);
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
  violations.push(...checkPackageIsolation(manifests, sources, TEST_KIT_ISOLATION));

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
  return violations;
}
