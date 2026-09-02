// Layering scans read tracked repository paths only. Most rules consume production TypeScript;
// the retired zones also consume every tracked path under their former roots so non-TS fixtures
// cannot bypass the ownership boundary.
//
// A leaf module on purpose. `check.ts` owns the scan and imports `package-boundaries.ts`, so the
// boundary rules cannot import `check.ts` back for its file list; without a shared leaf the two
// would each grow their own enumerator, and the moment those disagree a rule silently changes
// scope. That is not hypothetical -- it is the #1965 review finding this module exists to fix:
// `facadeEntryFiles` was briefly implemented as a raw `readdir` walk, which quietly widened R11
// from tracked files to whatever happened to be on disk.
//
// Tracked-only is a hard rule, not an optimization. A layering gate describes COMMITTED state:
// `docs/adr/0019-request-bound-platform-runtime.md` requires review "from a clean committed tree
// with all production files present in HEAD", and `check.ts` separately fails closed when
// production TypeScript is untracked. A scratch file a contributor has not committed -- a
// throwaway `facades/experiment.ts`, a half-finished module -- must be invisible here, or a gate
// that is supposed to describe the repository starts failing on the contents of someone's working
// directory instead.

import { execFileSync } from 'node:child_process';

// `src/**/*.ts` only matches NESTED files, so root-level `src/*.ts` (src/cli.ts,
// src/command-catalog.ts) needs its own pathspec or it silently drops out of every scan.
// Workspace package sources are production files too (#1490 W0).
const TRACKED_SOURCE_PATHSPECS = [
  'src/*.ts',
  'src/**/*.ts',
  'packages/*/src/*.ts',
  'packages/*/src/**/*.ts',
];

/**
 * Every tracked `packages/<pkg>/package.json`, repo-root-relative.
 *
 * The manifest half of the same rule. A package directory a contributor has created but not
 * committed declares no entry surfaces as far as any gate is concerned -- otherwise scratch work
 * changes what R11 and the loading-shape budgets police (#1965 review, second tracked-only pass).
 * `platform-package-repository.ts` already reads its manifests this way for R13; this is the same
 * enumeration widened to every workspace package.
 */
export function listTrackedPackageManifests(repoRoot: string): string[] {
  return listTrackedFiles(repoRoot, ['packages/*/package.json']);
}

/** Every tracked `.ts` source file under the scanned roots, repo-root-relative. */
export function listTrackedTypeScriptFiles(repoRoot: string): string[] {
  return listTrackedFiles(repoRoot, TRACKED_SOURCE_PATHSPECS);
}

/** Every tracked file under the retired platform root, regardless of extension. */
export function listTrackedPlatformZoneFiles(repoRoot: string): string[] {
  return listTrackedFilesUnderRoot(repoRoot, 'src/platforms');
}

/** Every tracked path at or under the retired `src/utils` root, regardless of extension. */
export function listTrackedSrcUtilsFiles(repoRoot: string): string[] {
  return listTrackedFilesUnderRoot(repoRoot, 'src/utils');
}

function listTrackedFilesUnderRoot(repoRoot: string, root: string): string[] {
  return listTrackedFiles(repoRoot, [root]);
}

function listTrackedFiles(repoRoot: string, pathspecs: readonly string[]): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return out.split('\0').filter(Boolean);
}

/** Production sources only: test files and `__tests__/` trees are not layering subjects. */
export function isProductionSourceFile(file: string): boolean {
  return file.endsWith('.ts') && !/(?:^|\/)__tests__\//.test(file) && !/\.test\.ts$/.test(file);
}

/** The canonical layering scan input: tracked, production, repo-root-relative. */
export function listTrackedProductionSources(repoRoot: string): string[] {
  return listTrackedTypeScriptFiles(repoRoot).filter(isProductionSourceFile);
}
