// Package tests cannot reach root test helpers (R11); fixture copy of tmp-dir.ts.
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a fresh scratch directory for one test. Cleanup is automatic: the
 * unit suite redirects TMPDIR to a per-run directory (scripts/vitest-tmpdir-global-setup.ts)
 * that gets removed in one recursive rm after every worker finishes, so
 * individual tests never need their own afterEach/afterAll for this.
 */
// fallow-ignore-next-line code-duplication
export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Sync counterpart of {@link mkdtempForTest}, for setup code that can't await. */
export function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
