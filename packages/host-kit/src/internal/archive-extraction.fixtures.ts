import { promises as fs } from 'node:fs';

import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';
import { runCmdSync } from './exec.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

export async function createArchiveWorkspace(): Promise<{
  archivePath: string;
  outputRoot: string;
  root: string;
}> {
  const root = await mkdtempForTest('agent-device-archive-');
  const outputRoot = path.join(root, 'output');
  await fs.mkdir(outputRoot);
  return { archivePath: path.join(root, 'fixture.archive'), outputRoot, root };
}

export async function createTruncatedTgz(archivePath: string): Promise<void> {
  const pack = tar.pack();
  pack.entry({ name: 'payload.bin' }, Buffer.from('AB'));
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const headerOnly = Buffer.concat(chunks).subarray(0, 512);
  await fs.writeFile(archivePath, gzipSync(headerOnly));
}

export async function createZipWithEncryptedSecondEntry(archivePath: string): Promise<void> {
  const staging = path.join(path.dirname(archivePath), 'zip-input');
  await fs.mkdir(staging);
  await fs.writeFile(path.join(staging, 'first.txt'), 'first');
  await fs.writeFile(path.join(staging, 'second.txt'), 'second');
  runCmdSync('zip', ['-q', archivePath, 'first.txt'], { cwd: staging });
  runCmdSync('zip', ['-q', '-P', 'secret', archivePath, 'second.txt'], { cwd: staging });
}
