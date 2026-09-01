import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { runCmdSync } from '../../src/utils/exec.ts';
import { resolveRepoRoot } from './host.ts';

test('CLI refuses an unmarked existing root before any descendant can be cleared', async () => {
  const repoRoot = resolveRepoRoot();
  const stateDir = await mkdtempForTest('agent-device-ios-benchmark-cli-');
  const derivedPath = path.join(stateDir, 'derived-data', 'cell');
  const sentinel = path.join(derivedPath, 'must-survive');
  fs.mkdirSync(derivedPath, { recursive: true });
  fs.writeFileSync(sentinel, 'keep');

  const result = runCmdSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(repoRoot, 'scripts/ios-snapshot-benchmark/run.ts'),
      '--udid',
      'unavailable-simulator',
      '--state-dir',
      stateDir,
      '--derived-path',
      derivedPath,
      '--skip-package-size',
    ],
    { cwd: repoRoot, allowFailure: true, timeoutMs: 60_000 },
  );

  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /benchmark-owned/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});
