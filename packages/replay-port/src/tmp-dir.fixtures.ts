import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The unit suite redirects TMPDIR to a per-run directory removed after all workers finish. */
// fallow-ignore-next-line code-duplication
export function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
