import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../types.ts';

import {
  refreshSessionDeviceIfNeeded,
  selectorTargetsSessionDevice,
} from '../session-device-utils.ts';
import { getRunnerSessionSnapshot } from '../../../platforms/apple/core/runner/runner-client.ts';
import { resolveTargetDevice } from '../../../core/dispatch.ts';
import { isActiveProviderDevice } from '../../../provider-device-runtime.ts';

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', () => ({
  getRunnerSessionSnapshot: vi.fn(() => null),
}));
vi.mock('../../../core/dispatch.ts', () => ({
  resolveTargetDevice: vi.fn(),
}));
vi.mock('../../../provider-device-runtime.ts', () => ({
  isActiveProviderDevice: vi.fn(() => false),
}));

const mockGetRunnerSessionSnapshot = vi.mocked(getRunnerSessionSnapshot);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockIsActiveProviderDevice = vi.mocked(isActiveProviderDevice);

beforeEach(() => {
  mockGetRunnerSessionSnapshot.mockReset();
  mockGetRunnerSessionSnapshot.mockReturnValue(null);
  mockResolveTargetDevice.mockReset();
  mockIsActiveProviderDevice.mockReset();
  mockIsActiveProviderDevice.mockReturnValue(false);
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
  mockGetRunnerSessionSnapshot.mockReturnValue({ sessionId: 'sim-1:1234:1', alive: true });

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device),
  );

  expect(device).toEqual({ ...iosSimulatorSession.device, booted: true });
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded re-resolves when the iOS runner session is gone', async () => {
  mockGetRunnerSessionSnapshot.mockReturnValue({ sessionId: 'sim-1:1234:1', alive: false });
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
