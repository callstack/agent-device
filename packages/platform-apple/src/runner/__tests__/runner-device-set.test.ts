import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { defaultRedirectProbeToFakeShims, writeHooklessXcrunShims } from './xcrun-shim-fixtures.ts';
import {
  acquireXcodebuildSimulatorSetRedirect,
  resolveXcodebuildSimulatorDeviceSetPath,
  withXcodebuildSimulatorSetRedirect,
} from '../runner-device-set.ts';

// A runner build runs under the XCTest device-set redirect, which is a lock like any other, so
// the two failures it can report have an order: the build that failed outranks a redirect it could
// not hand back, and a build that succeeded does not get to hide one.

beforeEach(() => {
  defaultRedirectProbeToFakeShims(writeHooklessXcrunShims(mkdtempForTestSync('device-set-shims-')));
});

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

async function acquireRedirect(
  paths: RedirectPaths,
  options: Partial<Parameters<typeof acquireXcodebuildSimulatorSetRedirect>[1]> = {},
): ReturnType<typeof acquireXcodebuildSimulatorSetRedirect> {
  return await acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), {
    ...redirectOptions(paths),
    ...options,
  });
}

function assertRedirectTargetsRequestedSet(paths: RedirectPaths): void {
  assert.equal(
    fs.realpathSync.native(paths.xctestDeviceSetPath),
    fs.realpathSync.native(paths.requestedSetPath),
  );
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

test('a restore that only works on the second look still ends the acquire', async () => {
  await withTempDir('device-set-restore-retried-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.backupPath, 'host-device.txt'), 'the host owns this');
    fs.symlinkSync(paths.requestedSetPath, paths.xctestDeviceSetPath, 'dir');

    // A first rename that fails and a retry that would succeed. What the acquire must not do is decide
    // from the state the failed restore left and then move the device set around without the lock.
    let restoreAttempts = 0;
    const realRename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(to) === paths.xctestDeviceSetPath) {
        restoreAttempts += 1;
        if (restoreAttempts === 1) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
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
          return true;
        },
      );
      assert.equal(
        fs.existsSync(paths.lockDirPath),
        false,
        'the lock must not outlive the failure',
      );
      // The retry put the host's set back, and nothing renamed it aside again on the way out.
      assert.equal(
        fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'utf8'),
        'the host owns this',
      );
      assert.equal(fs.existsSync(paths.backupPath), false);
    } finally {
      renameSpy.mockRestore();
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
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to redirect XCTest device set path');
          assert.match(String(error.details?.error), /EACCES/);
          assert.match(String(error.details?.restoreError), /EACCES/);
          assert.ok(String(error.details?.hint).includes(paths.backupPath));
          return true;
        },
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

test('a restore that half-finished names the backup it was refused, not an older leftover', async () => {
  await withTempDir('device-set-half-restored-legacy-', async (root) => {
    const paths = makeRedirectPaths(root);
    // The default backup path, so the older version's leftover prefix is the one a real host sees.
    const backupPath = `${paths.xctestDeviceSetPath}.agent-device-backup`;
    const legacyBackupPath = path.join(
      path.dirname(backupPath),
      '.agent-device-xctestdevices-backup-1600000000000',
    );
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(backupPath, { recursive: true });
    fs.writeFileSync(path.join(backupPath, 'host-device.txt'), 'the host owns this');
    fs.mkdirSync(legacyBackupPath, { recursive: true });
    fs.writeFileSync(path.join(legacyBackupPath, 'stale-device.txt'), 'an older interruption');
    fs.symlinkSync(paths.requestedSetPath, paths.xctestDeviceSetPath, 'dir');

    // An interrupted build left the symlink, this run's backup holds the host's set, and an older
    // version's leftover sits beside it. The first restore is refused after it took the symlink down, so
    // the hand-back is the one that puts the host's set back — and it is refused while deleting the
    // leftover. The report must name what is still renamed aside, which by then is nothing: sending the
    // reader to the older leftover would have them copy a stale set over the one now in place.
    const realRename = fs.renameSync;
    let restoreAttempts = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (String(to) === paths.xctestDeviceSetPath) {
        restoreAttempts += 1;
        if (restoreAttempts === 1) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
      }
      return realRename(from, to);
    }) as typeof fs.renameSync);
    const realRm = fs.rmSync;
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target, options) => {
      if (String(target) === legacyBackupPath) {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return realRm(target as Parameters<typeof fs.rmSync>[0], options);
    }) as typeof fs.rmSync);

    try {
      await assert.rejects(
        () =>
          acquireXcodebuildSimulatorSetRedirect(makeScopedSimulator(paths), redirectOptions(paths)),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to redirect XCTest device set path');
          assert.match(String(error.details?.error), /EACCES/);
          assert.match(String(error.details?.restoreError), /EPERM/);
          assert.equal(error.details?.hint, undefined);
          return true;
        },
      );
      assert.equal(fs.existsSync(legacyBackupPath), true, 'the leftover stays where it is');
      assert.equal(
        fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'utf8'),
        'the host owns this',
      );
      assert.equal(
        fs.existsSync(paths.lockDirPath),
        false,
        'the lock must not outlive the failure',
      );
    } finally {
      rmSpy.mockRestore();
      renameSpy.mockRestore();
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

test('resolveXcodebuildSimulatorDeviceSetPath uses XCTestDevices under the user home', () => {
  assert.equal(
    resolveXcodebuildSimulatorDeviceSetPath('/tmp/agent-device-home'),
    '/tmp/agent-device-home/Library/Developer/XCTestDevices',
  );
});

test('acquireXcodebuildSimulatorSetRedirect swaps XCTestDevices to the requested simulator set', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('device-set-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    const originalMarkerPath = path.join(root, 'original-marker.txt');
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
    fs.writeFileSync(
      path.join(paths.xctestDeviceSetPath, 'original.txt'),
      originalMarkerPath,
      'utf8',
    );

    handle = await acquireRedirect(paths);

    assert.notEqual(handle, null);
    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), true);
    assertRedirectTargetsRequestedSet(paths);

    await handle?.release();
    handle = null;

    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isDirectory(), true);
    assert.equal(
      fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'utf8'),
      originalMarkerPath,
    );
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect is a no-op for simulators without a scoped device set', async () => {
  const handle = await acquireXcodebuildSimulatorSetRedirect(iosSimulator);
  assert.equal(handle, null);
});

test('acquireXcodebuildSimulatorSetRedirect restores stale redirected XCTestDevices before applying a new one', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('device-set-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    const staleRequestedSetPath = path.join(root, 'stale-requested');
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(staleRequestedSetPath, { recursive: true });
    fs.mkdirSync(path.dirname(paths.xctestDeviceSetPath), { recursive: true });
    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.backupPath, 'original.txt'), 'restored', 'utf8');
    fs.symlinkSync(staleRequestedSetPath, paths.xctestDeviceSetPath, 'dir');

    handle = await acquireRedirect(paths, { backupPath: paths.backupPath });

    assert.notEqual(handle, null);
    assertRedirectTargetsRequestedSet(paths);

    await handle?.release();
    handle = null;

    assert.equal(fs.existsSync(paths.backupPath), false);
    assert.equal(
      fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'utf8'),
      'restored',
    );
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect restores the backup when XCTestDevices is a dangling symlink', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('device-set-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(path.dirname(paths.xctestDeviceSetPath), { recursive: true });
    fs.mkdirSync(paths.backupPath, { recursive: true });
    fs.writeFileSync(path.join(paths.backupPath, 'original.txt'), 'restored', 'utf8');
    // Stale redirect whose target set was deleted by its caller.
    fs.symlinkSync(path.join(root, 'deleted-requested'), paths.xctestDeviceSetPath, 'dir');

    handle = await acquireRedirect(paths, { backupPath: paths.backupPath });

    assert.notEqual(handle, null);
    assertRedirectTargetsRequestedSet(paths);

    await handle?.release();
    handle = null;

    assert.equal(fs.existsSync(paths.backupPath), false);
    assert.equal(
      fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'utf8'),
      'restored',
    );
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect clears stale lock directories from dead owners', async () => {
  let handle: Awaited<ReturnType<typeof acquireXcodebuildSimulatorSetRedirect>> | null = null;
  await withTempDir('device-set-redirect-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.lockDirPath, { recursive: true });
    fs.writeFileSync(
      path.join(paths.lockDirPath, 'owner.json'),
      JSON.stringify({ pid: 999_999, startTime: null, acquiredAtMs: Date.now() - 60_000 }),
      'utf8',
    );

    handle = await acquireRedirect(paths);

    assert.notEqual(handle, null);
    assert.equal(fs.lstatSync(paths.xctestDeviceSetPath).isSymbolicLink(), true);

    await handle?.release();
    handle = null;

    assert.equal(fs.existsSync(paths.lockDirPath), false);
  }).finally(async () => {
    await handle?.release();
  });
});

test('acquireXcodebuildSimulatorSetRedirect preserves the backup when XCTestDevices is recreated mid-swap', async () => {
  const renameSync = fs.renameSync.bind(fs);
  let xctestDeviceSetPath = '';
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((oldPath, newPath) => {
    if (
      typeof oldPath === 'string' &&
      typeof newPath === 'string' &&
      newPath === xctestDeviceSetPath &&
      oldPath.includes('.agent-device-link-')
    ) {
      fs.mkdirSync(xctestDeviceSetPath, { recursive: true });
      fs.writeFileSync(path.join(xctestDeviceSetPath, 'collision.txt'), 'collision', 'utf8');
    }
    return renameSync(oldPath, newPath);
  });
  try {
    await withTempDir('device-set-redirect-', async (root) => {
      const paths = makeRedirectPaths(root);
      xctestDeviceSetPath = paths.xctestDeviceSetPath;
      fs.mkdirSync(paths.requestedSetPath, { recursive: true });
      fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
      fs.writeFileSync(path.join(paths.xctestDeviceSetPath, 'original.txt'), 'original', 'utf8');

      await assert.rejects(
        acquireRedirect(paths, { backupPath: paths.backupPath }),
        /Failed to redirect XCTest device set path/,
      );

      assert.equal(
        fs.readFileSync(path.join(paths.backupPath, 'original.txt'), 'utf8'),
        'original',
      );
      assert.equal(
        fs.readFileSync(path.join(paths.xctestDeviceSetPath, 'collision.txt'), 'utf8'),
        'collision',
      );
    });
  } finally {
    renameSpy.mockRestore();
  }
});
