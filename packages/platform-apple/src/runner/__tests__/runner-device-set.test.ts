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
  lockDirPath: string;
};

function makeRedirectPaths(root: string): RedirectPaths {
  return {
    requestedSetPath: path.join(root, 'requested'),
    xctestDeviceSetPath: path.join(root, 'Library', 'Developer', 'XCTestDevices'),
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

test('a redirect that could not be installed reports the redirect, not the failed clean-up', async () => {
  await withTempDir('device-set-install-failure-', async (root) => {
    const paths = makeRedirectPaths(root);
    fs.mkdirSync(paths.requestedSetPath, { recursive: true });
    fs.mkdirSync(paths.xctestDeviceSetPath, { recursive: true });
    fs.writeFileSync(path.join(paths.xctestDeviceSetPath, 'host-device.txt'), 'the host owns this');

    // The install breaks after the host's set is renamed into the backup, and the restore that the
    // catch runs to undo it breaks too. Two failures, one report: the redirect that did not happen.
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
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.message, 'Failed to redirect XCTest device set path');
          assert.match(String(error.details?.error), /EPERM/);
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
