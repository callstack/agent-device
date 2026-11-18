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
  'a launched daemon starts when the mode update on its state paths fails with %s',
  async (code) => {
    // The real path: the state rule resolves the route it judges, and macOS's scratch directory rides the
    // `/var` to `/private/var` alias, so a name the walk answered and a name the test spells differ here.
    const paths = resolveDaemonPaths(
      path.join(fs.realpathSync(mkdtempForTestSync('agent-device-launch-chmod-')), 'state'),
    );
    // Both seams a state mode is asked at. A level this call CREATES takes its mode from the create itself,
    // with the umask masked; a level that already stands, and the log this call opened, take it on the OPEN
    // DESCRIPTOR, because `chmod` by name follows a link planted there.
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    const fchmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
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

      // The mode update was asked for, and it did not decide anything: a state directory this process could
      // not narrow is reported and left as it stands, and the daemon is still launched.
      assert.ok(chmod.mock.calls.length + fchmod.mock.calls.length > 0);
      assert.equal(fs.existsSync(paths.logPath), true);
    } finally {
      chmod.mockRestore();
      fchmod.mockRestore();
    }
  },
);
