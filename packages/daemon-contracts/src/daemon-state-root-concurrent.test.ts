import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';

// AC6: concurrent starters establishing one missing root. Each is its own process, so the race is the real
// one at `mkdir`, `lstat` and the walk's adopt-the-winner rule, not a mocked seam.
const ADMIT_SNIPPET = `
  import { admitDaemonStateRoot, resolveDaemonPaths } from ${JSON.stringify(
    path.join(process.cwd(), 'packages/daemon-contracts/src/daemon-resolution.ts'),
  )};
  admitDaemonStateRoot({ paths: resolveDaemonPaths(process.argv[1]), mode: 'establish' });
`;

function admitInChild(root: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '-e', ADMIT_SNIPPET, root],
      { stdio: 'ignore' },
    );
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

test.skipIf(process.platform === 'win32')(
  'starters establishing one missing root concurrently all see one private root',
  async () => {
    const root = path.join(
      fs.realpathSync(mkdtempForTestSync('state-admit-concurrent-')),
      'shared-state',
    );

    const codes = await Promise.all(Array.from({ length: 8 }, () => admitInChild(root)));

    assert.deepEqual(
      codes.filter((code) => code !== 0),
      [],
      `starters refused the root one of them created: ${codes.join(',')}`,
    );
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'sessions')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(root, 'sessions', 'remote-scripts')).mode & 0o777, 0o700);
  },
);
