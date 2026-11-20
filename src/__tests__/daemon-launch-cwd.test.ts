import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { launchDaemonProcess } from '@agent-device/daemon-contracts/daemon-registration-owner';
import {
  resolveDaemonPaths,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
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
 * The launcher's place in the order, for the shapes an operator's disk actually has. A missing root is created at
 * 0700, and an owned root that stands OPEN at 0755 — what CI hit, where the update-check cache writes the state
 * directory under the host's umask before any admission — is repaired and launched (#4649). Only a shape no mode
 * change can make private is refused, and then with no log and no registration beside it.
 * `admitDaemonStateRoot`'s own tests judge every unsafe shape.
 */
test.skipIf(process.platform === 'win32').for(['missing', 'open', 'planted link'])(
  'a launched daemon creates, repairs, or refuses the state dir from %s',
  async (start) => {
    const under = mkdtempForTestSync('agent-device-launch-mode-');
    const paths = resolveDaemonPaths(path.join(under, 'state'));
    const outside = path.join(under, 'outside');
    if (start === 'open') {
      fs.mkdirSync(paths.baseDir, { mode: 0o755 });
      fs.chmodSync(paths.baseDir, 0o755);
    }
    if (start === 'planted link') {
      fs.mkdirSync(outside, { mode: 0o700 });
      fs.symlinkSync(outside, paths.baseDir);
    }

    if (start === 'planted link') {
      assert.throws(
        () => launchDaemonProcess(launchOf(paths)),
        (error: unknown) =>
          (error as AppError).details?.reason === 'daemon_state_root_unsafe' &&
          (error as AppError).details?.component === paths.baseDir,
      );
      assert.equal(fs.existsSync(paths.logPath), false);
      assert.equal(fs.existsSync(paths.infoPath), false);
      assert.deepEqual(fs.readdirSync(outside), []);
      return;
    }

    const launch = launchDaemonProcess(launchOf(paths));
    await launch.exited;

    assert.equal(fs.statSync(paths.baseDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(paths.logPath).mode & 0o777, 0o600);
  },
);

function launchOf(paths: DaemonPaths): Parameters<typeof launchDaemonProcess>[0] {
  return {
    env: process.env,
    cwd: process.cwd(),
    paths,
    args: ['-e', ''],
    serverMode: 'socket',
  };
}
