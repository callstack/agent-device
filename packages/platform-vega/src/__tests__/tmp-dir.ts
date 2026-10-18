import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// fallow-ignore-next-line code-duplication
export function mkdtempForTestSync(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
