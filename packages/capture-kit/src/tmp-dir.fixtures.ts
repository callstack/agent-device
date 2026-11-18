import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Creates a fresh directory with no shared directory above it, for state that a sticky shared directory such
 * as `/tmp` must not hold: the Swift helper cache refuses one anywhere in its chain. It sits in the checkout's
 * ignored `.tmp/`, so the run's TMPDIR cleanup does not remove it: remove it when the test ends.
 * test-kit's `tmp-dir.ts` has the same helper; test-kit depends on this package, so each keeps a copy.
 */
export function mkdtempUnsharedForTestSync(prefix: string): string {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../.tmp/unshared-test-dirs',
  );
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return fs.mkdtempSync(path.join(root, prefix));
}
