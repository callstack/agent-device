import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { collectReplayActionArtifactPaths } from '../session-replay-runtime-artifacts.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

test('collectReplayActionArtifactPaths includes existing failed action artifacts', () => {
  const root = mkdtempForTestSync('agent-device-replay-artifacts-');
  const snapshotPath = path.join(root, 'failure-snapshot.txt');
  fs.writeFileSync(snapshotPath, 'snapshot');

  const paths = collectReplayActionArtifactPaths({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'assertion failed',
      details: {
        artifactPaths: [snapshotPath, path.join(root, 'missing.txt')],
      },
    },
  });

  assert.deepEqual(paths, [snapshotPath]);
});

test('collectReplayActionArtifactPaths collects top-level and nested successful artifacts', () => {
  const root = mkdtempForTestSync('agent-device-replay-success-artifacts-');
  const pathValue = path.join(root, 'path.txt');
  const outPath = path.join(root, 'out.txt');
  const localPath = path.join(root, 'local.txt');
  const nestedPath = path.join(root, 'nested.txt');
  for (const artifactPath of [pathValue, outPath, localPath, nestedPath]) {
    fs.writeFileSync(artifactPath, 'artifact');
  }

  const paths = collectReplayActionArtifactPaths({
    ok: true,
    data: {
      path: pathValue,
      outPath,
      artifacts: [
        { field: 'preferred', localPath, path: nestedPath },
        { field: 'nested', path: nestedPath },
        { field: 'missing', path: path.join(root, 'missing.txt') },
      ],
    },
  });

  assert.deepEqual(paths, [pathValue, outPath, localPath, nestedPath]);
});
