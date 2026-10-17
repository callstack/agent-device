// The one definition of which files the test-file size ratchet measures.
//
// The ratchet reads test files as text: it walks the tree and counts lines instead of importing
// them, so Vitest's module graph never reaches it (#3787). `scripts/check-affected` asks this
// module whether a changed file is measured, and then adds the ratchet's own test to the related
// run. The ratchet test and the selector must never disagree about the measured set, so the
// pattern, the roots, and the skipped directories live here and nowhere else.

import { repoRelativePath } from './repo-path.ts';

/** A test file past this line count may not grow, and a new one may not cross it. */
export const TEST_FILE_SIZE_RATCHET_TRIPWIRE_LINES = 1_000;

/** The ratchet's own test, the file the affected selector adds to the related run (#3787). */
export const TEST_FILE_SIZE_RATCHET_TEST_FILE = 'scripts/__tests__/test-file-size-ratchet.test.ts';

/** Top-level roots the ratchet walks, repo-relative. */
export const TEST_FILE_SIZE_RATCHET_ROOTS = ['src', 'packages', 'test', 'scripts'] as const;

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-types', '.tmp']);

const TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;

/**
 * Whether the ratchet measures `file`: a test file under one of the roots with no skipped
 * directory in its path. `file` may be absolute (resolved against `root`) or repo-relative.
 */
export function isTestFileSizeRatchetMeasured(file: string, root?: string): boolean {
  const relative = repoRelativePath(file, root);
  if (!TEST_FILE.test(relative)) return false;
  const segments = relative.split('/');
  if (!(TEST_FILE_SIZE_RATCHET_ROOTS as readonly string[]).includes(segments[0] ?? ''))
    return false;
  return !segments.some((part) => SKIPPED_DIRECTORIES.has(part));
}
