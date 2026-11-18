import fs from 'node:fs';
import path from 'node:path';

/**
 * Creates a fresh directory with no shared directory above it, for state a sticky shared directory such as
 * `/tmp` must not hold: the Swift helper cache refuses one anywhere in its chain. It sits in the run's own
 * directory under the checkout's ignored `.tmp/`, which the Vitest global setup names only after checking every
 * level above it, and removes after the run. The answer is the physical path, which the Swift cache compares.
 */
export function mkdtempUnsharedForTestSync(prefix: string): string {
  const runDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR?.trim();
  if (!runDir) {
    throw new Error(
      'AGENT_DEVICE_TEST_UNSHARED_DIR is unset: the Vitest global setup names it once the checkout chain is private.',
    );
  }
  return fs.realpathSync(fs.mkdtempSync(path.join(runDir, prefix)));
}
