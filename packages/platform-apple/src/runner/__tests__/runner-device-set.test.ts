import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  acquireXcodebuildSimulatorSetRedirect,
  withXcodebuildSimulatorSetRedirect,
} from '../runner-device-set.ts';

// A runner build runs under the XCTest device-set redirect, which is a lock like any other, so
// the two failures it can report have an order: the build that failed outranks a redirect it could
// not hand back, and a build that succeeded does not get to hide one.

const iosSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone Simulator',
  kind: 'simulator',
  appleOs: 'ios',
  booted: true,
};

type RedirectPaths = {
  requestedSetPath: string;
  xctestDeviceSetPath: string;
  backupPath: string;
  lockDirPath: string;
};

function makeRedirectPaths(root: string): RedirectPaths {
  return {
    requestedSetPath: path.join(root, 'requested'),
    xctestDeviceSetPath: path.join(root, 'Library', 'Developer', 'XCTestDevices'),
    backupPath: path.join(root, 'Library', 'Developer', 'XCTestDevices.set-aside'),
    lockDirPath: path.join(root, '.agent-device', 'xctest-device-set.lock'),
  };
}

function redirectOptions(paths: RedirectPaths) {
  return {
    lockDirPath: paths.lockDirPath,
    xctestDeviceSetPath: paths.xctestDeviceSetPath,
  };
}

function makeScopedSimulator(paths: RedirectPaths): DeviceInfo {
  return { ...iosSimulator, simulatorSetPath: paths.requestedSetPath };
}

/** The lock is standing and its record cannot be read, which is what no release can forgive. */
function makeReleaseUnverifiable(paths: RedirectPaths): void {
  const ownerFilePath = path.join(paths.lockDirPath, 'owner.json');
  fs.rmSync(ownerFilePath);
  fs.mkdirSync(ownerFilePath);
}

async function withTempDir<T>(prefix: string, task: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempForTestSync(prefix);
  try {
    return await task(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a build that failed outranks the redirect it could not give back', async () => {
  await withTempDir('device-set-build-error-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    const buildFailure = new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed', {
      hint: 'See the runner log.',
    });

    await assert.rejects(
      () =>
        withXcodebuildSimulatorSetRedirect(
          makeScopedSimulator(paths),
          async () => {
            makeReleaseUnverifiable(paths);
            throw buildFailure;
          },
          redirectOptions(paths),
        ),
      (error: unknown) => {
        assert.equal(error, buildFailure);
        return true;
      },
    );
    assert.equal(fs.existsSync(paths.lockDirPath), true);
  });
});

test('a build that succeeded still reports the redirect it could not give back', async () => {
  await withTempDir('device-set-release-error-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });

    await assert.rejects(
      () =>
        withXcodebuildSimulatorSetRedirect(
          makeScopedSimulator(paths),
          async () => {
            makeReleaseUnverifiable(paths);
            return 'built';
          },
          redirectOptions(paths),
        ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.ownerReleaseUnverified, true);
        return true;
      },
    );
  });
});

test('a redirect handed back after its task keeps quiet about a release it cannot verify', async () => {
  await withTempDir('device-set-teardown-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    const redirect = await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
      lockDirPath: paths.lockDirPath,
      xctestDeviceSetPath: paths.xctestDeviceSetPath,
    });
    assert.notEqual(redirect, null);
    makeReleaseUnverifiable(paths);

    await redirect?.releaseBestEffort();
    assert.equal(fs.existsSync(paths.lockDirPath), true);
  });
});

test('a redirect that could not restore the host device set reports it instead of swallowing it', async () => {
  await withTempDir('device-set-restore-failure-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    // The host has a device set of its own, so giving the redirect back renames it out of the
    // backup. Without this the release has nothing to restore and no rename to attempt.
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
    fs.writeFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'the host owns this');
    const redirect = await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
      lockDirPath: paths.lockDirPath,
      xctestDeviceSetPath: paths.xctestDeviceSetPath,
    });
    assert.notEqual(redirect, null);

    // The restore of the host's own `XCTestDevices` is a rename back from the backup, and a
    // refusal there is a fact about this machine that no caller may lose.
    let attempted = false;
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike,
    ) => {
      if (String(to) === paths.xctestDeviceSetPath && !attempted) {
        attempted = true;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realRename(from as string, to as string);
    }) as typeof fs.renameSync);

    try {
      await assert.rejects(
        () => redirect!.releaseBestEffort(),
        (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
      );
      assert.equal(attempted, true);
    } finally {
      renameSpy.mockRestore();
    }
  });
});

test('a restore that was refused outranks the lock that could not be verified', async () => {
  // Both steps lean on the same filesystem, so they fail together. The `finally` that handed the lock
  // back used to replace the restore's EACCES with `ownerReleaseUnverified`, which the best-effort
  // door then dropped and the strict door then reported in its place: the host kept an
  // `XCTestDevices` pointing at this simulator's set, and the only report named the lock.
  for (const door of ['release', 'releaseBestEffort'] as const) {
    await withTempDir(`device-set-both-fail-${door}-`, async (root) => {
      const paths = makeRedirectPaths(root);
      fs.mkdirSync(paths.requestedSetPath, { recursive: true });
      fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
      fs.writeFileSync(
        path.join(paths.xctestDeviceSetPath, 'host-device.txt'),
        'the host owns this',
      );
      const redirect = await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
        lockDirPath: paths.lockDirPath,
        xctestDeviceSetPath: paths.xctestDeviceSetPath,
      });
      assert.notEqual(redirect, null);
      makeReleaseUnverifiable(paths);

      let attempted = false;
      const realRename = fs.renameSync;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
        from: fs.PathLike,
        to: fs.PathLike,
      ) => {
        if (String(to) === paths.xctestDeviceSetPath && !attempted) {
          attempted = true;
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return realRename(from, to);
      }) as typeof fs.renameSync);

      try {
        await assert.rejects(
          () => redirect![door](),
          (error: unknown) => (error as NodeJS.ErrnoException).code === 'EACCES',
          door,
        );
        assert.equal(attempted, true, door);
        // The lock went back into the same refusing filesystem, which is what makes this the pair.
        assert.equal(fs.existsSync(paths.lockDirPath), true, `${door}: the release failed too`);
      } finally {
        renameSpy.mockRestore();
      }
    });
  }
});

test('an interrupted build that left the symlink is redirected again, not read as already done', async () => {
  await withTempDir('device-set-leftover-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    // What an interrupted build leaves: the host's set renamed aside, and `XCTestDevices` a symlink
    // pointing into this simulator's requested set. Following that symlink makes the two paths look
    // identical, and deciding from that would hand the symlink back and let the next `xcodebuild` run
    // against the host's own devices.
    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.backupPath, 'host-device.txt'), 'the host owns this');
    fs.symlinkSync(paths.requestedSetPath, paths.xctestDeviceSetPath, 'dir');

    const handle = await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
      ...redirectOptions(paths),
      backupPath: paths.backupPath,
    });

    try {
      assert.ok(handle, 'this simulator needs its own redirect, leftovers and all');
      assert.equal(
        fs.realpathSync.native(paths.xctestDeviceSetPath),
        fs.realpathSync.native(paths.requestedSetPath),
      );
      // The leftover backup was put back where it belongs and then renamed aside by this run, so the
      // host's device set is whole exactly once.
      assert.equal(
        fs.readFileSync(path.join(paths.backupPath, 'host-device.txt'), 'utf8'),
        'the host owns this',
      );

      await handle.release();
      assert.equal(
        fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'utf8'),
        'the host owns this',
      );
    } finally {
      await handle?.releaseBestEffort();
    }
  });
});

test('a restore that was refused on the way in is not reported as a simulator that needs no redirect', async () => {
  await withTempDir('device-set-leftover-restore-failed-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.backupPath, 'host-device.txt'), 'the host owns this');
    fs.symlinkSync(paths.requestedSetPath, paths.xctestDeviceSetPath, 'dir');

    // The same leftovers, with the rename that would put the host's set back refusing. Both paths still
    // resolve to the same directory, so this is the moment where "nothing to do" and "the host has no
    // device set" look identical from here.
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(to) === paths.xctestDeviceSetPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    try {
      await assert.rejects(
        () =>
          acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
            ...redirectOptions(paths),
            backupPath: paths.backupPath,
          }),
        /EACCES/,
      );
      // The host's set is still renamed aside, which is the fact the caller needs, and the lock went
      // back anyway so the next acquire does not wait on this one.
      assert.equal(fs.existsSync(paths.backupPath), true);
      assert.equal(fs.existsSync(paths.lockDirPath), false);
    } finally {
      renameSpy.mockRestore();
    }
  });
});

test('the host’s device set is back before the lock is', async () => {
  await withTempDir('device-set-hand-back-order-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });

    // The lock is what lets another runner build read the host's `XCTestDevices`, so the order the
    // give-back works in is the contract: releasing first would hand out a directory that is still a
    // symlink into this simulator's set. The events record when each step actually happened.
    const events: string[] = [];
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      const source = String(from);
      const target = String(to);
      if (target === paths.backupPath) events.push('renamed-aside');
      else if (source === paths.backupPath) events.push('restored');
      else if (target === paths.xctestDeviceSetPath) events.push('symlink-installed');
      return realRename(from, to);
    }) as typeof fs.renameSync);
    const realRemoveDir = fs.rmdirSync;
    const removeDirSpy = vi.spyOn(fs, 'rmdirSync').mockImplementation(((target, ...rest) => {
      if (String(target) === paths.lockDirPath) events.push('lock-released');
      return realRemoveDir(target, ...rest);
    }) as typeof fs.rmdirSync);

    try {
      const handle = await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
        ...redirectOptions(paths),
        backupPath: paths.backupPath,
      });
      assert.ok(handle);
      await handle.release();

      assert.deepEqual(events, ['renamed-aside', 'symlink-installed', 'restored', 'lock-released']);
    } finally {
      renameSpy.mockRestore();
      removeDirSpy.mockRestore();
    }
  });
});

test('a redirect that failed before it moved anything names no backup that is not there', async () => {
  await withTempDir('device-set-failed-before-rename-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
    fs.writeFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'the host owns this');

    // The install dies on the rename that was meant to move the host's set aside, so nothing ever left
    // its place. A report that still said "still renamed aside at <backup>" would send the reader to a
    // path that does not exist.
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(to) === paths.backupPath) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);

    try {
      await assert.rejects(
        () =>
          acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
            ...redirectOptions(paths),
            backupPath: paths.backupPath,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to redirect XCTest device set path');
          assert.match(String(error.details?.error), /EACCES/);
          assert.equal(error.details?.restoreError, undefined);
          assert.equal(error.details?.hint, undefined);
          return true;
        },
      );
      assert.equal(
        fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'utf8'),
        'the host owns this',
      );
    } finally {
      renameSpy.mockRestore();
    }
  });
});

test('a redirect that could not be installed reports the redirect, not the failed clean-up', async () => {
  await withTempDir('device-set-install-failure-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
    fs.writeFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'the host owns this');

    // The install breaks after the host's set is renamed into the backup, and the restore that the
    // catch runs to undo it breaks too. Two failures, one report: the redirect that did not happen,
    // carrying the restore that could not run and naming where the host's device set is waiting.
    let restoreAttempted = false;
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
      from: fs.PathLike,
      to: fs.PathLike,
    ) => {
      if (String(to) === paths.xctestDeviceSetPath) {
        restoreAttempted = true;
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    const symlinkSpy = vi.spyOn(fs, 'symlinkSync').mockImplementation((() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }) as typeof fs.symlinkSync);

    try {
      await assert.rejects(
        () =>
          acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
            lockDirPath: paths.lockDirPath,
            xctestDeviceSetPath: paths.xctestDeviceSetPath,
            backupPath: paths.backupPath,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to redirect XCTest device set path');
          assert.match(String(error.details?.error), /EPERM/);
          assert.match(String(error.details?.restoreError), /EACCES/);
          assert.ok(
            String(error.details?.hint).includes(paths.backupPath),
            `the hint must name where the host's device set is: ${String(error.details?.hint)}`,
          );
          return true;
        },
      );
      assert.equal(restoreAttempted, true);
      // The clean-up did not run to completion, and the lock went back regardless: the caller is
      // free to try again rather than wait 30 s on a claim nobody holds.
      assert.equal(fs.existsSync(paths.lockDirPath), false);
    } finally {
      renameSpy.mockRestore();
      symlinkSpy.mockRestore();
    }
  });
});
