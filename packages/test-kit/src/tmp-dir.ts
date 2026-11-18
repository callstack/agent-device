import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Creates a fresh scratch directory for one test. Cleanup is automatic: the
 * unit suite redirects TMPDIR to a per-run directory (scripts/vitest-tmpdir-global-setup.ts)
 * that gets removed in one recursive rm after every worker finishes, so
 * individual tests never need their own afterEach/afterAll for this.
 */
export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Sync counterpart of {@link mkdtempForTest}, for setup code that can't await. */
export function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Creates a fresh directory with no shared directory above it, for state that a sticky shared directory such
 * as `/tmp` must not hold: the Swift helper cache refuses one anywhere in its chain. It sits in the checkout's
 * ignored `.tmp/`, in the run's own directory there when the Vitest global setup named one; that setup removes
 * it after the run and prunes what a killed run abandoned. Remove it when the test ends all the same.
 */
export function mkdtempUnsharedForTestSync(prefix: string): string {
  const runDir = process.env.AGENT_DEVICE_TEST_UNSHARED_DIR?.trim();
  if (runDir) return fs.mkdtempSync(path.join(runDir, prefix));
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../.tmp/unshared-test-dirs',
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const seen = fs.lstatSync(root);
  if (!seen.isDirectory() || seen.uid !== process.getuid?.()) {
    throw new Error(`${root} is not a directory this user owns`);
  }
  fs.chmodSync(root, 0o700);
  return fs.mkdtempSync(path.join(root, prefix));
}
