import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findPathCommandInstances, whichCmd } from './exec-lookup.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

test('whichCmd resolves absolute executable paths without invoking a shell', async () => {
  assert.equal(await whichCmd(process.execPath, process.env), true);
});

test('whichCmd resolves bare commands from PATH', async () => {
  assert.equal(await whichCmd('node', process.env), true);
});

test('whichCmd rejects suspicious command strings', async () => {
  assert.equal(await whichCmd('node; rm -rf /', process.env), false);
  assert.equal(await whichCmd('./node', process.env), false);
});

test('whichCmd ignores directories that match a command name in PATH', async () => {
  const root = mkdtempForTestSync('agent-device-whichcmd-');
  const fakeCommandDir = path.join(root, 'fake-tool');
  fs.mkdirSync(fakeCommandDir);

  try {
    const env = { PATH: `${root}${path.delimiter}${process.env.PATH ?? ''}` };
    assert.equal(await whichCmd('fake-tool', env), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform !== 'win32')(
  'findPathCommandInstances lists every PATH hit in PATH order',
  async () => {
    const first = mkdtempForTestSync('agent-device-findpath-first-');
    const second = mkdtempForTestSync('agent-device-findpath-second-');
    for (const directory of [first, second]) {
      const hit = path.join(directory, 'agent-device');
      fs.writeFileSync(hit, '#!/bin/sh\n');
      fs.chmodSync(hit, 0o755);
    }

    try {
      assert.deepEqual(
        await findPathCommandInstances('agent-device', { PATH: `${first}:${second}` }),
        [path.join(first, 'agent-device'), path.join(second, 'agent-device')],
      );
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  },
);

test.runIf(process.platform !== 'win32')(
  'findPathCommandInstances skips directories without the command and collapses repeated PATH entries',
  async () => {
    const root = mkdtempForTestSync('agent-device-findpath-hit-');
    const empty = mkdtempForTestSync('agent-device-findpath-empty-');
    const missing = path.join(root, 'does-not-exist');
    const hit = path.join(root, 'agent-device');
    fs.writeFileSync(hit, '#!/bin/sh\n');
    fs.chmodSync(hit, 0o755);

    try {
      assert.deepEqual(
        await findPathCommandInstances('agent-device', {
          PATH: `${empty}:${missing}:${root}:${root}`,
        }),
        [hit],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(empty, { recursive: true, force: true });
    }
  },
);

test('findPathCommandInstances resolves nothing for a spelled-out path or an absent PATH', async () => {
  assert.deepEqual(await findPathCommandInstances(process.execPath, process.env), []);
  assert.deepEqual(await findPathCommandInstances('node', {}), []);
  assert.deepEqual(await findPathCommandInstances('node; rm -rf /', process.env), []);
});
