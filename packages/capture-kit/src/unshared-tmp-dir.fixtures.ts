import fs from 'node:fs';
import path from 'node:path';

/** The skip note for a Swift cache test in a run without a checkout-local directory. */
export const UNSHARED_TEST_DIR_MISSING = 'checkout ancestry not private; Swift cache tests skipped';

/**
 * A fresh directory in the run's checkout-local directory, for the Swift helper cache, which refuses `/tmp`; or
 * `undefined` in a run without one. test-kit's `unsharedTestRunDir` documents the rule; test-kit depends on this
 * package, so this one is kept separately.
 */
export function mkdtempUnsharedForTestSync(prefix: string): string | undefined {
  const runDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR;
  if (runDir) return fs.realpathSync(fs.mkdtempSync(path.join(runDir, prefix)));
  return undefined;
}
