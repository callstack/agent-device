import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { AndroidAdbFileHost } from '../../adb-host.ts';

export function createAndroidFileHost(): AndroidAdbFileHost {
  return {
    access: async (filePath) => await access(filePath),
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true });
    },
    isExecutable: async (filePath) => {
      try {
        await access(filePath, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    makeTempDirectory: async (prefix) => await mkdtemp(path.join(os.tmpdir(), prefix)),
    readBytes: async (filePath) => await readFile(filePath),
    readDirectory: async (directory) => await readdir(directory),
    readText: async (filePath) => await readFile(filePath, 'utf8'),
    remove: async (target, options) => await rm(target, options),
    sha256: (value) => createHash('sha256').update(value).digest('hex'),
    stat: async (filePath) => {
      const result = await stat(filePath);
      return { isFile: result.isFile(), size: result.size };
    },
    writeAtomicText: async (filePath, value, mode = 0o600) => {
      const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${randomUUID()}.tmp`,
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let published = false;
      try {
        handle = await open(temporaryPath, 'wx', mode);
        await handle.writeFile(value, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, filePath);
        published = true;
      } finally {
        if (handle) await handle.close().catch(() => {});
        if (!published) await rm(temporaryPath, { force: true }).catch(() => {});
      }
    },
    writeBytes: async (filePath, value) => await writeFile(filePath, value),
  };
}
