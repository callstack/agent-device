import fs from 'node:fs';
import path from 'node:path';

/**
 * A fresh directory in the run's checkout-local directory, for the Swift helper cache, which refuses `/tmp`.
 * test-kit's `mkdtempUnsharedForTestSync` documents the rule; test-kit depends on this package, so this one is
 * kept separately.
 */
export function mkdtempUnsharedForTestSync(prefix: string): string {
  const runDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR;
  if (!runDir)
    throw new Error('Run this test under the Vitest global setup, which names the run directory.');
  return fs.realpathSync(fs.mkdtempSync(path.join(runDir, prefix)));
}
