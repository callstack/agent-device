import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import type { SessionState } from '../../core/session-state.ts';
import { hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';

import {
  requireSessionOrExplicitSelector,
  resolveCommandDevice,
  refreshSessionDeviceIfNeeded,
  pinSessionDeviceSelection,
  resolvePowerCommandDevice,
  selectorTargetsSessionDevice,
} from '../session-device-resolution.ts';
import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { isActiveProviderDevice } from '../../core/provider-device-admission.ts';
import { ensureDeviceReady } from '../../core/device/device-ready.ts';
import { PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';

vi.mock('@agent-device/device-selection/dispatch-resolve', () => ({
  resolveTargetDevice: vi.fn(),
}));
vi.mock('../../core/provider-device-admission.ts', () => ({
  isActiveProviderDevice: vi.fn(() => false),
}));
vi.mock('../../core/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

// The runner-session probe is stubbed through the port (ADR 0019 section 11), never by mocking
// the platform module behind it.
const mockObserveRunnerSession = vi.fn();
const platformServices = daemonPlatformServicesFixture({
  appleSessionObservation: {
    observeRunnerSession: mockObserveRunnerSession,
    resolveSoleForegroundApp: async () => undefined,
  },
});
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockIsActiveProviderDevice = vi.mocked(isActiveProviderDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);

beforeEach(() => {
  mockObserveRunnerSession.mockReset();
  mockObserveRunnerSession.mockResolvedValue(undefined);
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
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device, platformServices, process.env),
  );

  expect(device).toBe(iosSimulatorSession.device);
});

test('resolveCommandDevice keeps an existing session for a platform-only filter', async () => {
  const requestServices = daemonPlatformServicesFixture({
    appleSessionObservation: {
      observeRunnerSession: mockObserveRunnerSession,
      resolveSoleForegroundApp: async () => undefined,
    },
  });
  const device = await withMockedPlatform(
    'linux',
    async () =>
      await resolveCommandDevice({
        platformServices: requestServices,
        session: iosSimulatorSession,
        flags: { platform: 'ios' },
        env: process.env,
      }),
  );

  expect(device).toBe(iosSimulatorSession.device);
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('resolveCommandDevice does not prepare a sessionless device', async () => {
  const device = { ...iosSimulatorSession.device, id: 'sessionless-sim' };
  mockResolveTargetDevice.mockResolvedValue(device);

  await resolveCommandDevice({
    session: undefined,
    flags: { platform: 'ios' },
    env: process.env,
    platformServices: platformServices,
  });

  expect(mockResolveTargetDevice).toHaveBeenCalledOnce();
  expect(mockEnsureDeviceReady).not.toHaveBeenCalled();
});

test('power command selection includes a stopped Android AVD', async () => {
  const stopped: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel_9',
    kind: 'emulator',
    booted: false,
  };
  mockResolveTargetDevice.mockResolvedValue(stopped);
  const selected = await resolvePowerCommandDevice({
    session: undefined,
    flags: { platform: 'android', device: 'Pixel_9' },
    env: process.env,
    platformServices,
  });
  expect(selected).toBe(stopped);
  expect(mockResolveTargetDevice).toHaveBeenCalledWith(
    { platform: 'android', device: 'Pixel_9' },
    { env: process.env, androidAvdSelection: 'include-stopped' },
  );
});

test('a request-scoped selected session device is reused by its later handler', async () => {
  const requestServices = daemonPlatformServicesFixture();
  const selected = { ...iosSimulatorSession.device, name: 'renamed', booted: true };
  pinSessionDeviceSelection(requestServices, iosSimulatorSession.device, selected);
  const resolved = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device, requestServices, process.env),
  );
  expect(resolved).toBe(selected);
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('the first normal session resolution pins the device for repeated work in one request', async () => {
  const requestServices = daemonPlatformServicesFixture({
    appleSessionObservation: {
      observeRunnerSession: mockObserveRunnerSession,
      resolveSoleForegroundApp: async () => undefined,
    },
  });
  mockObserveRunnerSession.mockResolvedValueOnce({ sessionId: 'sim-1:1234:1', alive: true });
  const [first, second] = await withMockedPlatform('darwin', async () => [
    await resolveCommandDevice({
      session: iosSimulatorSession,
      flags: undefined,
      env: process.env,
      platformServices: requestServices,
    }),
    await resolveCommandDevice({
      session: iosSimulatorSession,
      flags: undefined,
      env: process.env,
      platformServices: requestServices,
    }),
  ]);
  expect(second).toBe(first);
  expect(mockObserveRunnerSession).toHaveBeenCalledOnce();
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded keeps provider-owned iOS simulators out of local refresh', async () => {
  mockIsActiveProviderDevice.mockReturnValue(true);

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(
      { ...iosSimulatorSession.device, id: 'limrun:ios:lease-1' },
      platformServices,
      process.env,
    ),
  );

  expect(device.id).toBe('limrun:ios:lease-1');
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded skips re-resolve while the iOS runner session is alive', async () => {
  mockObserveRunnerSession.mockResolvedValue({
    sessionId: 'sim-1:1234:1',
    alive: true,
  });

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device, platformServices, process.env),
  );

  expect(device).toEqual({ ...iosSimulatorSession.device, booted: true });
  expect(mockResolveTargetDevice).not.toHaveBeenCalled();
});

test('refreshSessionDeviceIfNeeded re-resolves when the iOS runner session is gone', async () => {
  mockObserveRunnerSession.mockResolvedValue({
    sessionId: 'sim-1:1234:1',
    alive: false,
  });
  const resolved = { ...iosSimulatorSession.device, booted: true, name: 'renamed' };
  mockResolveTargetDevice.mockResolvedValue(resolved);

  const device = await withMockedPlatform('darwin', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device, platformServices, process.env),
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

test('requireSessionOrExplicitSelector refuses with the published reason and dispatched no', () => {
  const refusal = requireSessionOrExplicitSelector('clipboard', undefined, {});

  expect(refusal).not.toBeNull();
  expect(refusal?.ok).toBe(false);
  if (!refusal || refusal.ok) return;
  expect(refusal.error.code).toBe('INVALID_ARGS');
  expect(refusal.error.details?.reason).toBe(
    PRE_DISPATCH_REFUSAL_REASONS.sessionOrDeviceSelectorRequired,
  );
  expect(refusal.error.details?.dispatched).toBe('no');
});

for (const [label, session, flags] of [
  ['an active session', iosSimulatorSession, {}],
  ['an explicit platform selector', undefined, { platform: 'ios' }],
] as const) {
  test(`requireSessionOrExplicitSelector lets through ${label}`, () => {
    expect(requireSessionOrExplicitSelector('clipboard', session, flags)).toBeNull();
  });
}

test('resolveCommandDevice keeps an app device session on its app when a selector names the Mac', async () => {
  const mac: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-mac',
    name: 'Mac',
    kind: 'device',
    target: 'desktop',
  };
  const session: SessionState = {
    name: 'text-edit',
    createdAt: Date.now(),
    device: hostAppDevice(mac, 'com.apple.textedit'),
    actions: [],
  };
  mockResolveTargetDevice.mockResolvedValue(mac);

  const device = await resolveCommandDevice({
    platformServices,
    session,
    flags: { platform: 'macos', device: 'Mac' },
    env: process.env,
  });

  expect(device).toBe(session.device);
});
