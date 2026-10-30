import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createLocalArtifactAdapter } from './local-artifact-adapter.ts';

test('local artifact adapter marks command outputs and temp files by visibility', async () => {
  const adapter = createLocalArtifactAdapter();
  const output = await adapter.reserveOutput(undefined, {
    field: 'path',
    ext: '.png',
    artifactType: 'screenshot',
    visibility: 'client-visible',
  });
  const temp = await adapter.createTempFile({
    prefix: 'agent-device-test',
    ext: '.txt',
  });

  assert.equal(output.visibility, 'client-visible');
  assert.equal(temp.visibility, 'internal');

  await output.cleanup?.();
  await temp.cleanup();
});

test('local artifact adapter can constrain explicit local paths to a root', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-local-root-'));
  try {
    const adapter = createLocalArtifactAdapter({ cwd: root, rootDir: root });

    assert.deepEqual(
      await adapter.resolveInput({ kind: 'path', path: 'input.png' }, { usage: 'test' }),
      {
        path: path.join(root, 'input.png'),
      },
    );
    await assert.rejects(
      () => adapter.resolveInput({ kind: 'path', path: '../outside.png' }, { usage: 'test' }),
      /outside the artifact adapter root/,
    );
    await assert.rejects(
      () =>
        adapter.reserveOutput(
          { kind: 'path', path: path.join(path.dirname(root), 'outside.png') },
          { field: 'path', ext: '.png', artifactType: 'screenshot' },
        ),
      /outside the artifact adapter root/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
