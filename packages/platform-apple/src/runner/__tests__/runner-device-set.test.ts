import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from './tmp-dir.ts';
import {
  acquireXcodebuildSimulatorSetRedirect,
  releaseXcodebuildSimulatorSetRedirectBestEffort,
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

    await releaseXcodebuildSimulatorSetRedirectBestEffort(redirect);
    assert.equal(fs.existsSync(paths.lockDirPath), true);
  });
});
