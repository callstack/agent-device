import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Creates a fresh scratch directory for one test, as the KERNEL names it. Cleanup is automatic: the
 * unit suite redirects TMPDIR to a per-run directory (scripts/vitest-tmpdir-global-setup.ts)
 * that gets removed in one recursive rm after every worker finishes, so
 * individual tests never need their own afterEach/afterAll for this.
 *
 * The name is resolved because production code that judges a path resolves it too: a daemon repairing its
 * state chain answers the physical directory it arrived at (ADR 0016), and on macOS `os.tmpdir()` sits behind
 * `/tmp` → `/private/tmp`. A caller handed the spelled name would compare two spellings of one directory.
 */
export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/** Sync counterpart of {@link mkdtempForTest}, for setup code that can't await. */
export function mkdtempForTestSync(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
