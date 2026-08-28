import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runCmdSync } from '@agent-device/host-kit/command';

export async function createZipFixture(
  archivePath: string,
  directories: string[],
  files: Array<{ source: string; target: string }> = [],
): Promise<void> {
  const staging = await fs.mkdtemp(path.join(path.dirname(archivePath), 'zip-fixture-'));
  try {
    for (const directory of directories) {
      await fs.mkdir(path.join(staging, directory), { recursive: true });
    }
    for (const file of files) {
      const target = path.join(staging, file.target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(file.source, target);
    }
    runCmdSync('zip', ['-qr', archivePath, '.'], { cwd: staging });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
