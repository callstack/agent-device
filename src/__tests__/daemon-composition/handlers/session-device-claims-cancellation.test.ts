import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { fakeCreateCommandSurface } from '@agent-device/daemon/testing/__tests__/support/command-surface-fake';

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('@agent-device/daemon/testing/__tests__/device-selection-stub');
  const resolveTargetDevice = vi.fn();
  return {
    ...actual,
    resolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(resolveTargetDevice)),
  };
});
vi.mock('@agent-device/daemon/testing/device/device-ready', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
vi.mock('@agent-device/platform-android/mechanics', () => ({
  activateAndroidTestIme: vi.fn(async () => ({ activated: false })),
  restoreAndroidTestIme: vi.fn(async () => ({ restored: false, reason: 'no-record' })),
  stopAndroidSnapshotHelperSessionForDevice: vi.fn(async () => {}),
  resolveAndroidPackageForOpen: vi.fn(async () => undefined),
  inferAndroidPackageAfterOpen: vi.fn(
    async (_device, _target, currentAppBundleId) => currentAppBundleId,
  ),
}));
vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('@agent-device/test-kit/host-process-mock')).pinOwnProcessStartTime(importOriginal),
);

import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { ensureDeviceReady } from '@agent-device/daemon/testing/device/device-ready';
import {
  activateAndroidTestIme,
  resolveAndroidPackageForOpen,
} from '@agent-device/platform-android/mechanics';
import { clearRequestCanceled, markRequestCanceled } from '@agent-device/host-kit/request';
import { inspectDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { BindDeviceRuntime } from '@agent-device/daemon/testing/request-runtime-binding';
import {
  composedLifecycleRuntimeFixture,
  dispatchApplicationLifecycleEffect,
} from '../application-lifecycle-runtime-fixture.ts';
import { SessionStore } from '@agent-device/daemon/testing/session-store';
import { handleSessionOpenCommands as handleProductionOpenCommand } from '@agent-device/daemon/testing/session-lifecycle/index';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { inspectLifecycleRuntimeFacts } from '@agent-device/daemon/testing/__tests__/application-lifecycle-runtime-harness';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);
const mockResolveAndroidPackage = vi.mocked(resolveAndroidPackageForOpen);
const reconcileOrphanedDeviceClaim = async () => ({
  status: 'retained' as const,
  reason: 'test-no-recovery',
});

// The post-open test-IME activation is the real Android lifecycle's sequencing step after the
// open dispatch — the daemon-lane canned binding performs no IME leg, so this claim-retention
// case runs in the composition lane on the real composed lifecycle. The gateway seam's bind
// takes a full request context, which this suite's open call owns; the binding shape here
// mirrors it at the (device, use) seam the open command passes.
async function realLifecycleBinding(
  device: DeviceInfo,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts: await inspectLifecycleRuntimeFacts(device),
    operations: await composedLifecycleRuntimeFixture(device),
    [Symbol.asyncDispose]: async () => {},
  };
}

const bindRealLifecycleRuntime: BindDeviceRuntime = async (device, use) =>
  narrowDeviceBinding(await realLifecycleBinding(device), use);

let previousClaimsDir: string | undefined;

afterEach(() => {
  // The claims-dir override is this suite's scope: restore it so later tests in
  // the same worker never inspect or write claims under this case's temp root.
  if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
  previousClaimsDir = undefined;
  vi.clearAllMocks();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
  mockResolveAndroidPackage.mockResolvedValue(undefined);
});

function setup(): { store: SessionStore; stateDir: string } {
  const stateDir = mkdtempForTestSync('agent-device-session-device-claim-');
  const claimsDir = path.join(stateDir, 'claims');
  previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  return { store: new SessionStore(path.join(stateDir, 'sessions')), stateDir };
}

const android: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

test('cancellation after local device setup retains the device claim for recovery', async () => {
  const { store, stateDir } = setup();
  const requestId = 'claim-canceled-after-dispatch';
  mockResolveTargetDevice.mockResolvedValue(android);
  mockDispatch.mockResolvedValue(undefined);
  markRequestCanceled(requestId);

  try {
    const response = await handleProductionOpenCommand({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: composedPlatformServicesFixture(),
      req: {
        command: 'open',
        token: 'test',
        session: 'claim-canceled-after-dispatch',
        positionals: ['Demo'],
        flags: { platform: 'android' },
        meta: { requestId },
      },
      sessionName: 'claim-canceled-after-dispatch',
      logPath: path.join(stateDir, 'daemon.log'),
      sessionStore: store,
      inspectFacts: inspectLifecycleRuntimeFacts,
      bindDevice: bindRealLifecycleRuntime,
      reconcileOrphanedDeviceClaim,
    });

    assert.equal(response.ok, false);
    assert.equal(mockDispatch.mock.calls.length, 1);
    assert.equal(vi.mocked(activateAndroidTestIme).mock.calls.length, 1);
    assert.equal(inspectDeviceClaims({ serial: android.id })[0]?.classification, 'live');
    assert.equal(store.get('claim-canceled-after-dispatch'), undefined);
  } finally {
    clearRequestCanceled(requestId);
  }
});
