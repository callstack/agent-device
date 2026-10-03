import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import {
  accessHostFile,
  copyHostFile,
  ensureHostDirectory,
  hostFileStat,
  makeHostTemporaryDirectory,
  readHostBinaryFile,
  readHostDirectory,
  readHostTextFile,
  removeHostPath,
  renameHostPath,
  writeHostBinaryFile,
  writeHostTextFile,
} from './host-file.ts';

test('host-file ports preserve text, binary, directory, and path operations', async () => {
  const root = await makeHostTemporaryDirectory('agent-device-host-file-');
  try {
    const nested = path.join(root, 'nested');
    const source = path.join(nested, 'source.txt');
    const copy = path.join(root, 'copy.txt');
    const renamed = path.join(root, 'renamed.txt');
    await ensureHostDirectory(nested);
    await writeHostTextFile(source, 'host-file');
    const bytes = path.join(nested, 'bytes.bin');
    await writeHostBinaryFile(bytes, Buffer.from([1, 2, 3]));

    assert.equal(await readHostTextFile(source), 'host-file');
    assert.deepEqual(await readHostBinaryFile(bytes), Buffer.from([1, 2, 3]));
    assert.equal((await hostFileStat(source)).isFile(), true);
    assert.deepEqual((await readHostDirectory(nested)).sort(), ['bytes.bin', 'source.txt']);
    assert.equal((await readHostDirectory(root, { withFileTypes: true })).length, 1);

    await copyHostFile(source, copy);
    await renameHostPath(copy, renamed);
    await accessHostFile(renamed);
  } finally {
    await removeHostPath(root);
  }
});
