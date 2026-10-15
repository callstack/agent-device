// Catches: a workspace package whose `exports` publish test support — a fixture, fake, mock,
//   harness, `__tests__/` module or `./testing/*` entry — so a test elsewhere can reach it, and a
//   production file importing one of those entries or the private `@agent-device/test-kit`
//   package. Tests belong beside the module they test and import it relatively; fixtures one
//   package uses stay inside it; fixtures shared across packages live in `@agent-device/test-kit`,
//   the one designated home. A production package's `exports` is its production surface.
//   The offender list only shrinks: a new offender fails, and so does a list entry that no longer
//   offends, so each cleanup deletes the entries it frees.
// Evidence: 122 exports across 10 packages existed only to feed tests (daemon `./testing/*`,
//   `*-fixtures` on capture-kit, selectors, device-selection, ...), each a production-looking
//   subpath nothing but a test imports. TEST_ONLY_FIXTURE_SUBPATHS (R11) and R13's Android list
//   named two and four of them by hand; neither stopped the next one.
// Cost: one manifest scan plus one specifier check at the R11 import sites.
// Kill criterion: a maintainer decision that packages may publish test support in `exports`.
//
// R83 package-export-surface. Classification looks at the export key AND its target file, so
// renaming the key cannot hide a fixture, and naming a fixture `./thing` cannot either.
// `@agent-device/test-kit` is the one package exempt from the export check. `test/` (integration,
// e2e, wire-compat) and `scripts/` are not production sources.

import type { LayeringViolation } from './model.ts';
import { TEST_ONLY_EXPORT_BURN_DOWN } from './package-export-surface-burn-down.ts';

export const PACKAGE_EXPORT_SURFACE_RULE = 'R83 package-export-surface';

export const TEST_KIT_PACKAGE = '@agent-device/test-kit';

/** Words that mark a path segment or file name as test support, split on `/ . - _`. */
const TEST_ONLY_TOKENS: ReadonlySet<string> = new Set([
  'testing',
  'fixture',
  'fixtures',
  'fake',
  'fakes',
  'mock',
  'mocks',
  'stub',
  'stubs',
  'harness',
]);

/** `test-<word>` pairs that mark test support; `test-command` and `session-test-*` do not. */
const TEST_COMPANION_TOKENS: ReadonlySet<string> = new Set([
  'support',
  'host',
  'helper',
  'helpers',
  'util',
  'utils',
  'kit',
]);

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const TEST_DIRECTORY = /^(?:__[a-z]+__|tests?)$/;

function hasTestOnlyTokens(segment: string): boolean {
  const tokens = segment
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some(
    (token, index) =>
      TEST_ONLY_TOKENS.has(token) ||
      (token === 'test' && TEST_COMPANION_TOKENS.has(tokens[index + 1] ?? '')),
  );
}

/** An export key such as `./testing/context` or `./snapshot-state-fixtures`. */
export function isTestOnlyExportKey(key: string): boolean {
  return key.split('/').some((segment) => segment === '__tests__' || hasTestOnlyTokens(segment));
}

/** An export target relative to its package, such as `./src/snapshot-state.fixtures.ts`. */
export function isTestOnlyExportTarget(target: string): boolean {
  const segments = target.split('/').filter((segment) => segment !== '.' && segment !== '');
  const file = segments.pop() ?? '';
  return (
    TEST_FILE.test(file) ||
    hasTestOnlyTokens(file) ||
    segments.some((segment) => TEST_DIRECTORY.test(segment) || hasTestOnlyTokens(segment))
  );
}

/** Whether an export is test support, judged by its key and by every file it resolves to. */
export function isTestOnlyExport(key: string, targets: readonly string[]): boolean {
  return isTestOnlyExportKey(key) || targets.some(isTestOnlyExportTarget);
}

const TEST_FILE_TREE =
  /(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$|(?:^|\/)test\/|^packages\/test-kit\//;

/**
 * A file that is itself test support, so importing other test support is allowed there: the root
 * `test/` tree, a package-local `test/` tree, `*.test.*` files, `__tests__/` trees, `*.fixtures.*`
 * files and the test-kit package.
 */
export function isTestSupportFile(file: string): boolean {
  return TEST_FILE_TREE.test(file) || hasTestOnlyTokens(file.slice(file.lastIndexOf('/') + 1));
}

/**
 * Production source: root `src/` and `packages/<pkg>/src/`, minus the test-support files. The
 * root `test/` tree and `scripts/` are not production sources, so tooling and vitest setup there
 * may import test support.
 */
export function isProductionSource(file: string): boolean {
  return /^(?:src|packages\/[^/]+\/src)\//.test(file) && !isTestSupportFile(file);
}

function stripPackageDir(target: string): string {
  return target.replace(/^packages\/[^/]+\//, './');
}

export type ExportManifest = {
  file: string;
  name: string;
  /** Export key -> every string the entry resolves to (all conditions). */
  exports: ReadonlyMap<string, readonly string[]>;
};

function stringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) stringLeaves(child, out);
  }
  return out;
}

export function readExportManifests(manifests: ReadonlyMap<string, string>): ExportManifest[] {
  const parsed: ExportManifest[] = [];
  for (const [file, text] of [...manifests].sort(([a], [b]) => a.localeCompare(b))) {
    const manifest = JSON.parse(text) as { name?: string; exports?: unknown };
    if (!manifest.name) continue;
    const exported =
      typeof manifest.exports === 'string'
        ? { '.': manifest.exports }
        : ((manifest.exports as Record<string, unknown> | undefined) ?? {});
    parsed.push({
      file,
      name: manifest.name,
      exports: new Map(Object.entries(exported).map(([key, value]) => [key, stringLeaves(value)])),
    });
  }
  return parsed;
}

function violation(file: string, message: string): LayeringViolation {
  return { rule: PACKAGE_EXPORT_SURFACE_RULE, file, line: 1, message };
}

/**
 * Every test-only export of every package except test-kit must be in the burn-down list, and
 * every list entry must still offend. `burnDown` entries read `<package> <export key>`.
 */
export function checkPackageExportSurface(
  manifests: ReadonlyMap<string, string>,
  burnDown: readonly string[] = TEST_ONLY_EXPORT_BURN_DOWN,
): LayeringViolation[] {
  const listed = new Set(burnDown);
  const offending = new Set<string>();
  const violations: LayeringViolation[] = [];
  for (const pkg of readExportManifests(manifests)) {
    if (pkg.name === TEST_KIT_PACKAGE) continue;
    for (const [key, targets] of pkg.exports) {
      if (!isTestOnlyExport(key, targets.map(stripPackageDir))) continue;
      const entry = `${pkg.name} ${key}`;
      offending.add(entry);
      if (listed.has(entry)) continue;
      violations.push(
        violation(
          pkg.file,
          `'${pkg.name}' exports '${key}', which is test support (${targets.join(', ')}). ` +
            `A package's exports are its production surface: keep the file inside the package ` +
            `and import it relatively, or move a genuinely shared helper to ${TEST_KIT_PACKAGE}.`,
        ),
      );
    }
  }
  for (const entry of burnDown) {
    if (offending.has(entry)) continue;
    violations.push(
      violation(
        'scripts/layering/package-export-surface-burn-down.ts',
        `'${entry}' no longer exports test support; delete it from TEST_ONLY_EXPORT_BURN_DOWN.`,
      ),
    );
  }
  return violations;
}

/**
 * The consumer-side half: production code never imports test-only exports or test-kit. The caller
 * has already resolved `specifier` to `packageName` and, when the package names it, the
 * `exportKey` and file `targets` it resolves through.
 */
export function testOnlyImportMessage(
  file: string,
  specifier: string,
  packageName: string,
  resolved: { key: string; targets: readonly string[] } | undefined,
): string | undefined {
  if (!isProductionSource(file)) return undefined;
  if (packageName === TEST_KIT_PACKAGE) {
    return `'${specifier}' is the private test-only package; production source may not import it.`;
  }
  if (!resolved || !isTestOnlyExport(resolved.key, resolved.targets.map(stripPackageDir))) {
    return undefined;
  }
  return (
    `'${specifier}' is a test-only export — production code may not import it; use the ` +
    `package's production subpath or inject the port.`
  );
}

/**
 * Whether a full workspace specifier such as `@agent-device/platform-apple/runner/test-host`
 * names a test-only export, judged by its key alone. For rules that hold only the specifier;
 * R83's manifest scan also judges the target file.
 */
export function isTestOnlyExportSpecifier(specifier: string): boolean {
  const match = /^@[^/]+\/[^/]+(\/.*)?$/.exec(specifier);
  if (!match) return false;
  return isTestOnlyExportKey(`.${match[1] ?? ''}`);
}
