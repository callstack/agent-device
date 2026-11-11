import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { launchDaemonProcess } from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { mkdtempForTestSync } from '@agent-device/test-kit';

test('a launched daemon starts in the working directory of the host that launched it', async () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-launch-cwd-'));
  const hostCwd = fs.realpathSync(mkdtempForTestSync('agent-device-launch-host-cwd-'));
  const reported = path.join(paths.baseDir, 'cwd.txt');
  assert.notEqual(hostCwd, fs.realpathSync(process.cwd()));
  const launch = launchDaemonProcess({
    env: process.env,
    cwd: hostCwd,
    paths,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(reported)}, process.cwd())`],
    serverMode: 'socket',
  });

  await launch.exited;

  assert.equal(fs.readFileSync(reported, 'utf8'), hostCwd);
});

test.skipIf(process.platform === 'win32').for(['fresh', 'loose'])(
  'a launched daemon gets a private state dir and log from a %s state dir',
  async (start) => {
    const paths = resolveDaemonPaths(
      path.join(mkdtempForTestSync('agent-device-launch-mode-'), 'state'),
    );
    if (start === 'loose') {
      fs.mkdirSync(paths.baseDir, { mode: 0o755 });
      fs.chmodSync(paths.baseDir, 0o755);
      fs.writeFileSync(paths.logPath, '', { mode: 0o644 });
      fs.chmodSync(paths.logPath, 0o644);
    }
    const launch = launchDaemonProcess({
      env: process.env,
      cwd: process.cwd(),
      paths,
      args: ['-e', ''],
      serverMode: 'socket',
    });

    await launch.exited;

    assert.equal(fs.statSync(paths.baseDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.logPath).mode & 0o777, 0o600);
  },
);

test.for(['EPERM', 'EROFS'])(
  'a launched daemon starts when chmod on its state paths fails with %s',
  async (code) => {
    const paths = resolveDaemonPaths(
      path.join(mkdtempForTestSync('agent-device-launch-chmod-'), 'state'),
    );
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    try {
      const launch = launchDaemonProcess({
        env: process.env,
        cwd: process.cwd(),
        paths,
        args: ['-e', ''],
        serverMode: 'socket',
      });
      await launch.exited;
      assert.deepEqual(
        chmod.mock.calls.map(([target]) => target),
        [paths.baseDir, paths.logPath],
      );
    } finally {
      chmod.mockRestore();
    }
  },
);
