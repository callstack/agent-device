// The test files the test-file size ratchet (scripts/__tests__/test-file-size-ratchet.test.ts)
// measures. The affected-check selector reads the same definition, because the ratchet walks the
// tree instead of importing its subjects and so is invisible to Vitest's module graph.

export const MEASURED_TEST_ROOTS: readonly string[] = ['src', 'packages', 'test', 'scripts'];
export const UNMEASURED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'dist-types',
  '.tmp',
]);
const MEASURED_TEST_FILE = /\.test\.(?:ts|tsx|mjs)$/;

/** `repoPath` is a repo-relative path with `/` separators. */
export function isMeasuredTestFile(repoPath: string): boolean {
  if (!MEASURED_TEST_FILE.test(repoPath)) return false;
  const parts = repoPath.split('/');
  return (
    MEASURED_TEST_ROOTS.includes(parts[0] ?? '') &&
    !parts.some((part) => UNMEASURED_DIRECTORIES.has(part))
  );
}
