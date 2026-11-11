import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { REPO_ROOT } from '@agent-device/test-kit';
import { scanDaemonFixtureLaunches } from '../../scripts/lib/daemon-fixture-launch-guard.ts';

test('daemon fixture family mocks use declared launch plans', () => {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((file) => /^(src\/|packages\/[^/]+\/src\/).*\.ts$/.test(file))
    .map((file) => ({ file, source: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
  assert.deepEqual(scanDaemonFixtureLaunches(files), []);
});

test('daemon fixture guard rejects its adversarial cases in the PR unit lane', () => {
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      'scripts/mutation/daemon-fixture-launch-guard.test.ts',
    ],
    { cwd: REPO_ROOT, stdio: 'pipe' },
  );
});
