import fs from 'node:fs';
import path from 'node:path';

/** Why a test that needs the run's checkout-local directory is skipped when the run has none. */
export const UNSHARED_TEST_DIR_MISSING = 'checkout ancestry not private; Swift cache tests skipped';

/**
 * The run's own directory under the checkout's ignored `.tmp/`, for state a sticky shared directory such as
 * `/tmp` must not hold: the Swift helper cache refuses one anywhere in its chain. The Vitest global setup names
 * it only after checking every level from `/` down, and removes it after the run. A run whose checkout ancestry
 * is not private (a mount another user owns, for example) has none: a test that needs it skips with
 * {@link UNSHARED_TEST_DIR_MISSING}, and every other test runs without touching it.
 */
export function unsharedTestRunDir(): string | undefined {
  return process.env.AGENT_DEVICE_TEST_UNSHARED_DIR?.trim() || undefined;
}

/** A fresh directory in {@link unsharedTestRunDir}, as its physical path, which the Swift cache compares. */
export function mkdtempUnsharedForTestSync(prefix: string): string | undefined {
  const runDir = unsharedTestRunDir();
  return runDir && fs.realpathSync(fs.mkdtempSync(path.join(runDir, prefix)));
}
