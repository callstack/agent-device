import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { classifyFailure } from './command.ts';
import { runCliAsync } from './cli-process.ts';

test('preserves timeout classification when execFile reports no string error code', async () => {
  const repoRoot = await mkdtempForTest('agent-device-ios-benchmark-timeout-');
  fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'bin/agent-device.mjs'),
    'setTimeout(() => undefined, 1000);\n',
  );

  const result = await runCliAsync(
    {
      repoRoot,
      stateDir: path.join(repoRoot, 'state'),
      session: 'timeout-test',
      udid: 'timeout-test',
      derivedPath: path.join(repoRoot, 'derived'),
    },
    ['noop'],
    100,
  );

  assert.equal(result.ok, false);
  assert.equal(result.spawnErrorCode, 'ETIMEDOUT');
  assert.equal(classifyFailure(result.payload, result).category, 'timeout');
});
