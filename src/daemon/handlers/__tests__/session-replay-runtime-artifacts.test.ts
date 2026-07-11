import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { collectReplayActionArtifactPaths } from '../session-replay-runtime-artifacts.ts';

test('collectReplayActionArtifactPaths includes existing failed action artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-artifacts-'));
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
