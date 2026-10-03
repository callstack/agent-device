import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// fallow-ignore-next-line code-duplication
export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}
