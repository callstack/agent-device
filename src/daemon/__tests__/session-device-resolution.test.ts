import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../types.ts';

import {
  resolveCommandDevice,
  refreshSessionDeviceIfNeeded,
  selectorTargetsSessionDevice,
} from '../session-device-resolution.ts';
import { getRunnerSessionSnapshot } from '@agent-device/platform-apple/runner/operations';
import { resolveTargetDevice } from '../../core/dispatch-resolve.ts';
import { isActiveProviderDevice } from '../../provider-device-runtime.ts';
import { ensureDeviceReady } from '../device-ready.ts';

vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  getRunnerSessionSnapshot: vi.fn(async () => null),
}));
vi.mock('../../core/dispatch-resolve.ts', () => ({
  resolveTargetDevice: vi.fn(),
}));
vi.mock('../../provider-device-runtime.ts', () => ({
  isActiveProviderDevice: vi.fn(() => false),
}));
vi.mock('../device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

const mockGetRunnerSessionSnapshot = vi.mocked(getRunnerSessionSnapshot);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockIsActiveProviderDevice = vi.mocked(isActiveProviderDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);

beforeEach(() => {
  mockGetRunnerSessionSnapshot.mockReset();
  mockGetRunnerSessionSnapshot.mockResolvedValue(null);
  mockResolveTargetDevice.mockReset();
  mockIsActiveProviderDevice.mockReset();
  mockIsActiveProviderDevice.mockReturnValue(false);
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
});

const iosSimulatorSession: SessionState = {
  name: 'ios-sim',
  createdAt: Date.now(),
  device: {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
  },
  actions: [],
};

async function withMockedPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

test('refreshSessionDeviceIfNeeded keeps iOS simulator session device on non-mac hosts', async () => {
  const device = await withMockedPlatform('linux', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device),
  );

  expect(device).toBe(iosSimulatorSession.device);
});

test('resolveCommandDevice keeps an existing session for a platform-only filter', async () => {
  const device = await withMockedPlatform(
    'linux',
    async () =>
      await resolveCommandDevice({
        session: iosSimulatorSession,
        flags: { platform: 'ios' },
      }),
  );

  expect(device).toBe(iosSimulatorSession.device);
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('resolveCommandDevice does not prepare a sessionless device', async () => {
  const device = { ...iosSimulatorSession.device, id: 'sessionless-sim' };
  mockResolveTargetDevice.mockResolvedValue(device);

  await resolveCommandDevice({ session: undefined, flags: { platform: 'ios' } });

  expect(mockResolveTargetDevice).toHaveBeenCalledOnce();
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded keeps provider-owned iOS simulators out of local refresh', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded({
      ...iosSimulatorSession.device,
      id: 'limrun:ios:lease-1',
    }),
  );

  expect(device.id).toBe('limrun:ios:lease-1');
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded skips re-resolve while the iOS runner session is alive', async () => {
  mockGetRunnerSessionSnapshot.mockResolvedValue({ sessionId: 'sim-1:1234:1', alive: true });

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device),
  );

  expect(device).toEqual({ ...iosSimulatorSession.device, booted: true });
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded re-resolves when the iOS runner session is gone', async () => {
  mockGetRunnerSessionSnapshot.mockResolvedValue({ sessionId: 'sim-1:1234:1', alive: false });
  const resolved = { ...iosSimulatorSession.device, booted: true, name: 'renamed' };
  mockResolveTargetDevice.mockResolvedValue(resolved);

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device),
  );

  expect(device).toBe(resolved);
  expect(mockResolveTargetDevice).toHaveBeenCalledTimes(1);
});

test('selectorTargetsSessionDevice uses session selector conflicts for simulator set selectors', () => {
  const session: SessionState = {
    ...iosSimulatorSession,
    device: {
      ...iosSimulatorSession.device,
      simulatorSetPath: '/tmp/session-set',
    },
  };

  expect(selectorTargetsSessionDevice({ iosSimulatorDeviceSet: '/tmp/session-set' }, session)).toBe(
    true,
  );
  expect(selectorTargetsSessionDevice({ iosSimulatorDeviceSet: '/tmp/other-set' }, session)).toBe(
    false,
  );
});
