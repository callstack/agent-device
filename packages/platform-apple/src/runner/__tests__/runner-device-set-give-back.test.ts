import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from './tmp-dir.ts';

// Which failure a redirect hands the caller is decided once, in the give-back. These tests reach the
// paths that have no handle to give back — the simulator that needs no redirect, and the redirect
// that never got installed — by answering the lock at the seam the module already acquires it
// through, which is the only window where a release can be made to fail from inside an acquire.
const { lockSeam } = vi.hoisted(() => ({
  lockSeam: {
    override: null as null | (() => Promise<() => Promise<void>>),
  },
}));

vi.mock('../host.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host.ts')>();
  return {
    ...actual,
    acquireProcessLock: async (params: Parameters<typeof actual.acquireProcessLock>[0]) =>
      lockSeam.override ? await lockSeam.override() : await actual.acquireProcessLock(params),
  };
});

import { acquireXcodebuildSimulatorSetRedirect } from '../runner-device-set.ts';

function unverifiedRelease(): () => Promise<void> {
  return async () => {
    throw new AppError('COMMAND_FAILED', 'Could not verify ownership of XCTest device set lock', {
      ownerReleaseUnverified: true,
    });
  };
}

afterEach(() => {
  lockSeam.override = null;
});

test('a simulator already on the host device set is not failed by a lock it could not verify', async () => {
  const root = mkdtempForTestSync('device-set-no-redirect-');
  try {
    const xctestDeviceSetPath = path.join(root, 'Library', 'Developer', 'XCTestDevices');
    fs.mkdirSync(xctestDeviceSetPath, { recursive: true });
    // This simulator's set and the host's `XCTestDevices` are the same directory, so nothing is
    // redirected and the caller is told so with a null handle. Before the give-back rule, the
    // release inside the try fell into the catch, which reconciled, released again, and raised
    // "Failed to redirect XCTest device set path" for a redirect that was never needed.
    lockSeam.override = async () => unverifiedRelease();
    const device: DeviceInfo = {
      platform: 'apple',
      id: 'sim-host-set',
      name: 'iPhone Simulator',
      kind: 'simulator',
      appleOs: 'ios',
      booted: true,
      simulatorSetPath: xctestDeviceSetPath,
    };

    const redirect = await acquireXcodebuildSimulatorSetRedirect(device, {
      lockDirPath: path.join(root, '.agent-device', 'xctest-device-set.lock'),
      xctestDeviceSetPath,
    });

    assert.equal(redirect, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
