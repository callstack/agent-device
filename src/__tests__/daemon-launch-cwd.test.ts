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
  'a launched daemon starts when forcing a mode on its state paths fails with %s',
  async (code) => {
    const paths = resolveDaemonPaths(
      path.join(mkdtempForTestSync('agent-device-launch-chmod-'), 'state'),
    );
    // A state directory an older version left group-writable, so the repair has something to do.
    fs.mkdirSync(paths.baseDir, { mode: 0o755 });
    fs.chmodSync(paths.baseDir, 0o775);
    // Neither way of forcing a mode works: a mount that refuses chmod, or one whose semantics this host
    // does not implement. Startup reports that and starts anyway rather than dying on a host it cannot fix.
    const failing = () => {
      throw Object.assign(new Error(code), { code });
    };
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(failing);
    const fchmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(failing);
    try {
      const launch = launchDaemonProcess({
        env: process.env,
        cwd: process.cwd(),
        paths,
        args: ['-e', ''],
        serverMode: 'socket',
      });

      await launch.exited;

      // Each path is asked for the mode in the one way that is safe for it: the state DIRECTORY through a
      // descriptor opened on the entry the repair judged, so the mode cannot travel through a planted link,
      // and the log FILE by its name.
      assert.deepEqual(
        fchmod.mock.calls.map(([, mode]) => mode),
        [0o700],
      );
      assert.deepEqual(
        chmod.mock.calls.map(([target]) => target),
        [paths.logPath],
      );
      assert.deepEqual(
        fchmod.mock.calls.map(([, mode]) => mode),
        [0o700],
      );
      assert.deepEqual(
        chmod.mock.calls.map(([target]) => target),
        [paths.logPath],
      );
    } finally {
      chmod.mockRestore();
      fchmod.mockRestore();
    }
  },
);
