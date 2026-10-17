// Catches: a workspace package whose `exports` publish test support — a fixture, fake, mock,
//   harness, `__tests__/` module or `./testing/*` entry — so a test elsewhere can reach it, and a
//   production file importing one of those entries or the private `@agent-device/test-kit`
//   package. Tests belong beside the module they test and import it relatively; fixtures one
//   package uses stay inside it; fixtures shared across packages live in `@agent-device/test-kit`,
//   the one designated home. A package's `exports` is its production surface.
//   Today's offenders only shrink: the set is measured at the merge-base with origin/main by the
//   same function that measures the working tree (`ratchet-reference.ts`), so growth fails, a
//   cleanup needs no edit, and no allowlist exists to append to.
// Evidence: 122 exports across 10 packages existed only to feed tests (daemon `./testing/*`,
//   `*-fixtures` on capture-kit, selectors, device-selection, ...), each a production-looking
//   subpath nothing but a test imports. Hand-kept lists of two and four of them (R11, R13) did
//   not stop the next one.
// Cost: one manifest scan per tree plus one specifier check at the R11 import sites.
// Kill criterion: a maintainer decision that packages may publish test support in `exports`.
//
// R83 package-export-surface. Classification looks at the export key AND every file the entry
// resolves to under every condition (`types`, `import`, `default`, ...), expanding `*` patterns
// against the tracked package files, so neither a key rename nor a catch-all pattern hides a
// fixture. `@agent-device/test-kit` is the one package exempt from the export check. "Production
// source" is `isProductionSourceFile` in `tracked-sources.ts`.

import { resolveWorkspaceSpecifier, type LayeringViolation } from './model.ts';
import { isProductionSourceFile } from './tracked-sources.ts';

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

/**
 * Whether a full workspace specifier such as `@agent-device/platform-apple/runner/test-host`
 * names a test-only export, judged by its key alone. For rules that hold only the specifier;
 * R83's manifest scan also judges the target files.
 */
export function isTestOnlyExportSpecifier(specifier: string): boolean {
  const match = /^@[^/]+\/[^/]+(\/.*)?$/.exec(specifier);
  if (!match) return false;
  return isTestOnlyExportKey(`.${match[1] ?? ''}`);
}

function stripPackageDir(target: string): string {
  return target.replace(/^packages\/[^/]+\//, './');
}

/** One export of one package: its key and every string leaf of its conditions map. */
export type ExportEntry = {
  key: string;
  targets: readonly string[];
};

export type ExportManifest = {
  file: string;
  name: string;
  exports: readonly ExportEntry[];
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
      exports: Object.entries(exported).map(([key, value]) => ({
        key,
        targets: stringLeaves(value),
      })),
    });
  }
  return parsed;
}

/**
 * The files a `*` pattern target covers among the tracked package files. A pattern with no
 * match stands for its own text, so a pattern aimed at `__tests__/` is judged before any file
 * exists. A literal target is its own single file.
 */
export function expandExportTarget(
  packageDir: string,
  target: string,
  packageFiles: readonly string[],
): string[] {
  const star = target.indexOf('*');
  if (star === -1) return [target];
  const prefix = `${packageDir}/${target.slice(0, star).replace(/^\.\//, '')}`;
  const suffix = target.slice(star + 1);
  const matches = packageFiles.filter(
    (file) =>
      file.startsWith(prefix) &&
      file.length > prefix.length + suffix.length &&
      file.endsWith(suffix),
  );
  return matches.length > 0
    ? matches.map((file) => `./${file.slice(packageDir.length + 1)}`)
    : [target];
}

/** A test-only export of a package, with the files that made it one. */
export type TestOnlyExport = {
  /** `<package> <export key>`: the identity the merge-base comparison keys on. */
  id: string;
  manifestFile: string;
  key: string;
  targets: readonly string[];
};

/**
 * Every test-only export of every package except test-kit in one tree. `packageFiles` is that
 * tree's tracked paths, so wildcard exports are judged by the files they publish.
 */
export function measureTestOnlyExports(
  manifests: ReadonlyMap<string, string>,
  packageFiles: readonly string[],
): TestOnlyExport[] {
  const offenders: TestOnlyExport[] = [];
  for (const pkg of readExportManifests(manifests)) {
    if (pkg.name === TEST_KIT_PACKAGE) continue;
    const packageDir = pkg.file.replace(/\/package\.json$/, '');
    for (const { key, targets } of pkg.exports) {
      const files = targets.flatMap((target) =>
        expandExportTarget(packageDir, target, packageFiles),
      );
      if (!isTestOnlyExport(key, files)) continue;
      offenders.push({ id: `${pkg.name} ${key}`, manifestFile: pkg.file, key, targets: files });
    }
  }
  return offenders;
}

/**
 * Growth fails: a test-only export at head that the merge-base did not already publish. A
 * cleanup that removes exports needs no edit, and nothing sits above what main actually holds.
 */
export function checkPackageExportSurface(
  head: readonly TestOnlyExport[],
  base: readonly TestOnlyExport[],
): LayeringViolation[] {
  const published = new Set(base.map(({ id }) => id));
  return head
    .filter(({ id }) => !published.has(id))
    .map(({ id, manifestFile, key, targets }) => {
      const support = targets.filter(isTestOnlyExportTarget);
      return {
        rule: PACKAGE_EXPORT_SURFACE_RULE,
        file: manifestFile,
        line: 1,
        message:
          `'${id.slice(0, id.indexOf(' '))}' exports '${key}', which is test support ` +
          `(${[...new Set(support.length > 0 ? support : targets)].slice(0, 3).join(', ')}). ` +
          `A package's exports are its production surface: keep the file inside the package ` +
          `and import it relatively, or move a genuinely shared helper to ${TEST_KIT_PACKAGE}.`,
      };
    });
}

/** The `R83` success-line fragment: how many test-only exports remain, against the merge-base. */
export function packageExportSurfaceSummary(
  head: readonly TestOnlyExport[],
  base: readonly TestOnlyExport[],
): string {
  return (
    `package exports publish no new test support: ${head.length} test-only export(s) remain ` +
    `against ${base.length} at the merge-base (R83)`
  );
}

/**
 * Every condition target an import specifier resolves to, repo-relative, through the same
 * exports semantics as `resolveWorkspaceSpecifier`. `conditionTargets` maps each export key to
 * all of its condition leaves, in declaration order.
 */
export function resolveAllConditionTargets(
  specifier: string,
  conditionTargets: ReadonlyMap<string, readonly string[]>,
): string[] {
  const width = Math.max(0, ...[...conditionTargets.values()].map((targets) => targets.length));
  const resolved = new Set<string>();
  for (let slot = 0; slot < width; slot += 1) {
    const slotTargets = new Map<string, string>();
    for (const [key, targets] of conditionTargets) {
      const target = targets[slot];
      if (target !== undefined) slotTargets.set(key, target);
    }
    const target = resolveWorkspaceSpecifier(specifier, slotTargets);
    if (target !== undefined) resolved.add(target);
  }
  return [...resolved];
}

/**
 * The consumer-side half: production code never imports test-only exports or test-kit. The caller
 * has already resolved `specifier` to `packageName` and, when the package names it, every
 * condition target it resolves through.
 */
export function testOnlyImportMessage(
  file: string,
  specifier: string,
  packageName: string,
  resolvedTargets: readonly string[] | undefined,
): string | undefined {
  if (!isProductionSourceFile(file)) return undefined;
  if (packageName === TEST_KIT_PACKAGE) {
    return `'${specifier}' is the private test-only package; production source may not import it.`;
  }
  if (resolvedTargets === undefined) return undefined;
  const key = `.${specifier.slice(packageName.length)}`;
  if (!isTestOnlyExport(key, resolvedTargets.map(stripPackageDir))) return undefined;
  return (
    `'${specifier}' is a test-only export — production code may not import it; use the ` +
    `package's production subpath or inject the port.`
  );
}
