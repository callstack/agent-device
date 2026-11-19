import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
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

/**
 * A missing state directory is created at 0700 by the admission the launcher asks for, and the log it opens
 * beside it at 0600. A root that stands OPEN is refused before that log is opened, rather than repaired:
 * `admitDaemonStateRoot`'s own tests judge every unsafe shape, so what this one proves is the launcher's
 * place in the order — the refusal arrives with no log and no registration beside the root.
 */
test.skipIf(process.platform === 'win32').for(['private', 'open'])(
  'a launched daemon gets a private state dir, or refuses an open one, from %s',
  async (start) => {
    const paths = resolveDaemonPaths(
      path.join(mkdtempForTestSync('agent-device-launch-mode-'), 'state'),
    );
    if (start === 'open') {
      fs.mkdirSync(paths.baseDir, { mode: 0o755 });
      fs.chmodSync(paths.baseDir, 0o755);
    }
    if (start === 'private') {
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
      return;
    }

    assert.throws(
      () =>
        launchDaemonProcess({
          env: process.env,
          cwd: process.cwd(),
          paths,
          args: ['-e', ''],
          serverMode: 'socket',
        }),
      (error: unknown) =>
        (error as AppError).details?.reason === 'daemon_state_root_unsafe' &&
        (error as AppError).details?.component === paths.baseDir,
    );
    assert.equal(fs.existsSync(paths.logPath), false);
    assert.equal(fs.existsSync(paths.infoPath), false);
    assert.deepEqual(fs.readdirSync(paths.baseDir), []);
  },
);
