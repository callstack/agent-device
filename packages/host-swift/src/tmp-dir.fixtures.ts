import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A fresh temp directory. Test-kit depends on capture-kit, which depends on this package, so this package keeps this local. */
export async function mkdtempForTest(prefix: string): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
}
