import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { REPO_ROOT } from '@agent-device/test-kit';
import { scanDaemonFixtureLaunches } from '../../scripts/lib/daemon-fixture-launch-guard.ts';

// Parses every source file in src/ and packages/*/src (about 4,000), so it needs more than the
// default 5 s under coverage instrumentation on shared runners.
const WHOLE_TREE_SCAN_TIMEOUT_MS = 60_000;

test(
  'daemon fixture family mocks use declared launch plans',
  () => {
    const files = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    )
      .split('\0')
      .filter((file) => /^(src\/|packages\/[^/]+\/src\/).*\.ts$/.test(file))
      .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)))
      .map((file) => ({ file, source: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));
    assert.deepEqual(scanDaemonFixtureLaunches(files), []);
  },
  WHOLE_TREE_SCAN_TIMEOUT_MS,
);
