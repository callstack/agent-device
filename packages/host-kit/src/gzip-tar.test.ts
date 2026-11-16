import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { runCmd, withCommandExecutorOverride } from './command.ts';
import { packGzipTar } from './gzip-tar.ts';
import { mkdtempForTestSync } from './internal/tmp-dir.fixtures.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bundle(name: string): string {
  const root = mkdtempForTestSync('gzip-tar-fixture-');
  roots.push(root);
  const directory = path.join(root, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'Info.plist'), 'plist');
  return directory;
}

async function entries(archivePath: string): Promise<string[]> {
  const { stdout } = await runCmd('tar', ['tzf', archivePath], { env: process.env });
  return stdout.split('\n').filter(Boolean).sort();
}

test('packs the directory as the archive’s one top-level entry, and cleanup removes it', async () => {
  const packed = await packGzipTar(bundle('Example.app'), { env: process.env });
  assert.equal(path.basename(packed.archivePath), 'Example.app.tar.gz');
  assert.deepEqual(await entries(packed.archivePath), ['Example.app/', 'Example.app/Info.plist']);
  packed.cleanup();
  assert.equal(fs.existsSync(path.dirname(packed.archivePath)), false);
  packed.cleanup();
});

test('a directory name that starts with a dash is packed as a name, not read as an option', async () => {
  const packed = await packGzipTar(bundle('-v.app'), { env: process.env, fileName: 'build.tgz' });
  try {
    assert.equal(path.basename(packed.archivePath), 'build.tgz');
    assert.deepEqual(await entries(packed.archivePath), ['-v.app/', '-v.app/Info.plist']);
  } finally {
    packed.cleanup();
  }
});

test('a pack that fails leaves no temporary directory behind', async () => {
  let archivePath = '';
  await assert.rejects(
    withCommandExecutorOverride(
      (cmd, args) => {
        if (cmd !== 'tar') return undefined;
        archivePath = String(args[1]);
        throw new Error('tar unavailable');
      },
      async () => await packGzipTar(bundle('Example.app'), { env: process.env }),
    ),
    /tar unavailable/,
  );
  assert.notEqual(archivePath, '');
  assert.equal(fs.existsSync(path.dirname(archivePath)), false);
});

test('an already-aborted pack starts no tar and leaves nothing behind', async () => {
  const controller = new AbortController();
  controller.abort(new Error('canceled'));
  let ran = false;
  await assert.rejects(
    withCommandExecutorOverride(
      (cmd) => {
        if (cmd === 'tar') ran = true;
        return undefined;
      },
      async () =>
        await packGzipTar(bundle('Example.app'), { env: process.env, signal: controller.signal }),
    ),
    /canceled/,
  );
  assert.equal(ran, false);
});
