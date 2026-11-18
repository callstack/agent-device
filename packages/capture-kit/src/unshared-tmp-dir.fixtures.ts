import fs from 'node:fs';
import path from 'node:path';

/**
 * A fresh directory in the run's checkout-local directory, for the Swift helper cache, which refuses `/tmp`.
 * Without one the test is skipped, or fails on CI. test-kit's `requireUnsharedTestRunDir` documents the rule;
 * test-kit depends on this package, so this one is kept separately.
 */
export function mkdtempUnsharedForTestSync(
  prefix: string,
  test: Readonly<{ skip: (note: string) => never }>,
): string {
  const runDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR;
  if (runDir) return fs.realpathSync(fs.mkdtempSync(path.join(runDir, prefix)));
  const why = `checkout ancestry not private: ${process.env.AGENT_DEVICE_TEST_UNSHARED_UNAVAILABLE ?? 'no checkout-local directory was named'}`;
  if (process.env.CI) throw new Error(why);
  return test.skip(`${why}; Swift cache tests skipped`);
}
