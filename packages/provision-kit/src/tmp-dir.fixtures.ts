// Package tests cannot reach root test helpers (R11); fixture copy of tmp-dir.ts.
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// fallow-ignore-next-line code-duplication
export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}
