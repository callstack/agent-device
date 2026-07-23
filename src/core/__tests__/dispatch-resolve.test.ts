import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const {
  mockFindBootableIosSimulator,
  mockFindIosSimulatorInstalledApp,
  mockListAppleDevices,
  mockListAndroidDevices,
} = vi.hoisted(() => ({
  mockFindBootableIosSimulator: vi.fn(),
  mockFindIosSimulatorInstalledApp: vi.fn(),
  mockListAppleDevices: vi.fn(),
  mockListAndroidDevices: vi.fn(),
}));

vi.mock('../../platforms/apple/core/devices.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/devices.ts')>();
  return {
    ...actual,
    findBootableIosSimulator: mockFindBootableIosSimulator,
    listAppleDevices: mockListAppleDevices,
  };
});

vi.mock('../../platforms/android/devices.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/devices.ts')>();
  return {
    ...actual,
    listAndroidDevices: mockListAndroidDevices,
  };
});

vi.mock('../../platforms/apple/core/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/apps.ts')>();
  return {
    ...actual,
    findIosSimulatorInstalledApp: mockFindIosSimulatorInstalledApp,
  };
});

import {
  resolveTargetDevice,
  withDeviceInventoryProvider,
  withResolveTargetDeviceCacheScope,
} from '../dispatch-resolve.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';

const physical: DeviceInfo = {
  platform: 'apple',
  id: 'phys-1',
  name: 'My iPhone',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

const simulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-1',
  name: 'iPhone 16',
  kind: 'simulator',
  target: 'mobile',
  booted: false,
};

const bootedSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-2',
  name: 'iPhone 15',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const secondBootedSimulator: DeviceInfo = {
  platform: 'apple',
  id: 'sim-3',
  name: 'iPhone 16',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};

const webDesktop: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const androidEmulator: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9 Pro XL',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  mockFindBootableIosSimulator.mockReset();
  mockFindBootableIosSimulator.mockResolvedValue(null);
  mockFindIosSimulatorInstalledApp.mockReset();
  mockFindIosSimulatorInstalledApp.mockResolvedValue(undefined);
  mockListAppleDevices.mockReset();
  mockListAndroidDevices.mockReset();
});

test('resolveTargetDevice narrows local Android discovery to an explicit serial', async () => {
  mockListAndroidDevices.mockResolvedValue([androidEmulator]);

  const result = await resolveTargetDevice({
    platform: 'android',
    serial: androidEmulator.id,
  });

  assert.equal(result.id, androidEmulator.id);
  assert.deepEqual(Array.from(mockListAndroidDevices.mock.calls[0]?.[0]?.serialAllowlist ?? []), [
    androidEmulator.id,
  ]);
});

test('resolveTargetDevice does not discover an explicit Android serial outside its allowlist', async () => {
  mockListAndroidDevices.mockResolvedValue([]);

  await expectDeviceNotFound(() =>
    resolveTargetDevice({
      platform: 'android',
      serial: androidEmulator.id,
      androidDeviceAllowlist: 'emulator-5556',
    }),
  );

  assert.deepEqual(
    Array.from(mockListAndroidDevices.mock.calls[0]?.[0]?.serialAllowlist ?? []),
    [],
  );
});

test('resolveTargetDevice reuses request-scoped device resolution cache for identical selectors', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator]);

  const [first, second] = await withResolveTargetDeviceCacheScope(async () => [
    await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' }),
    await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' }),
  ]);

  assert.equal(first.id, 'sim-2');
  assert.equal(second.id, 'sim-2');
  assert.equal(mockListAppleDevices.mock.calls.length, 1);
});

test('resolveTargetDevice request cache key separates device selectors', async () => {
  mockListAppleDevices.mockResolvedValue([simulator, bootedSimulator]);

  await withResolveTargetDeviceCacheScope(async () => {
    await resolveTargetDevice({ platform: 'ios', device: 'iPhone 16' });
    await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' });
  });

  assert.equal(mockListAppleDevices.mock.calls.length, 2);
});

test('resolveTargetDevice selects the unique booted simulator with the requested app', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);
  mockFindIosSimulatorInstalledApp.mockImplementation(async (device) =>
    device.id === secondBootedSimulator.id ? 'com.example.demo' : undefined,
  );

  const result = await resolveTargetDevice(
    { platform: 'ios' },
    { appleSimulatorAppTarget: 'com.example.demo' },
  );

  assert.equal(result.id, secondBootedSimulator.id);
  assert.deepEqual(
    mockFindIosSimulatorInstalledApp.mock.calls.map(([device, app]) => [device.id, app]),
    [
      [bootedSimulator.id, 'com.example.demo'],
      [secondBootedSimulator.id, 'com.example.demo'],
    ],
  );
});

test('resolveTargetDevice reuses an app-aware selection for later request resolution', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);
  mockFindIosSimulatorInstalledApp.mockImplementation(async (device) =>
    device.id === secondBootedSimulator.id ? 'com.example.demo' : undefined,
  );

  const [appAware, laterResolution] = await withResolveTargetDeviceCacheScope(async () => [
    await resolveTargetDevice({ platform: 'ios' }, { appleSimulatorAppTarget: 'com.example.demo' }),
    await resolveTargetDevice({ platform: 'ios' }),
  ]);

  assert.equal(appAware.id, secondBootedSimulator.id);
  assert.equal(laterResolution.id, secondBootedSimulator.id);
  assert.equal(mockListAppleDevices.mock.calls.length, 1);
});

test('resolveTargetDevice refuses booted simulator selection when the requested app is absent', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);

  const error = await resolveTargetDevice(
    { platform: 'ios' },
    { appleSimulatorAppTarget: 'com.example.demo' },
  ).catch((cause) => cause);

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'APP_NOT_INSTALLED');
  assert.match(error.message, /No booted iOS simulator has com\.example\.demo installed/);
  assert.deepEqual(error.details?.candidates, [
    { id: bootedSimulator.id, name: bootedSimulator.name },
    { id: secondBootedSimulator.id, name: secondBootedSimulator.name },
  ]);
});

test('resolveTargetDevice refuses ambiguous booted simulator app matches', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);
  mockFindIosSimulatorInstalledApp.mockResolvedValue('com.example.demo');

  const error = await resolveTargetDevice(
    { platform: 'ios' },
    { appleSimulatorAppTarget: 'com.example.demo' },
  ).catch((cause) => cause);

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'AMBIGUOUS_MATCH');
  assert.match(error.message, /Multiple booted iOS simulators have com\.example\.demo installed/);
  assert.equal(error.details?.hint, 'Pass --udid to select the intended simulator explicitly.');
});

test('resolveTargetDevice does not probe when an Apple device is explicitly selected', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);

  const result = await resolveTargetDevice(
    { platform: 'ios', udid: bootedSimulator.id },
    { appleSimulatorAppTarget: 'com.example.demo' },
  );

  assert.equal(result.id, bootedSimulator.id);
  assert.equal(mockFindIosSimulatorInstalledApp.mock.calls.length, 0);
});

test('resolveTargetDevice does not reuse cache across request scopes', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator]);

  await withResolveTargetDeviceCacheScope(
    async () => await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' }),
  );
  await withResolveTargetDeviceCacheScope(
    async () => await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' }),
  );

  assert.equal(mockListAppleDevices.mock.calls.length, 2);
});

test('resolveTargetDevice reuses cache across nested request scopes', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator]);

  await withResolveTargetDeviceCacheScope(async () => {
    await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' });
    await withResolveTargetDeviceCacheScope(
      async () => await resolveTargetDevice({ platform: 'ios', device: 'iPhone 15' }),
    );
  });

  assert.equal(mockListAppleDevices.mock.calls.length, 1);
});

test('resolveTargetDevice uses injected device inventory without local discovery', async () => {
  const result = await withDeviceInventoryProvider(
    async (request) => {
      assert.equal(request.platform, 'ios');
      assert.equal(request.deviceName, 'Remote iPhone');
      return [{ ...bootedSimulator, id: 'remote-ios-1', name: 'Remote iPhone' }];
    },
    async () => await resolveTargetDevice({ platform: 'ios', device: 'Remote iPhone' }),
  );

  assert.equal(result.id, 'remote-ios-1');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice preserves Apple simulator preference with injected inventory', async () => {
  mockFindBootableIosSimulator.mockResolvedValue(simulator);

  const result = await withDeviceInventoryProvider(
    async (request) => {
      assert.equal(request.platform, 'ios');
      return [physical];
    },
    async () => await resolveTargetDevice({ platform: 'ios' }),
  );

  assert.equal(result.id, 'sim-1');
  assert.equal(result.kind, 'simulator');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice treats empty injected inventory as authoritative', async () => {
  await expectDeviceNotFound(() =>
    withDeviceInventoryProvider(
      async () => [],
      async () => await resolveTargetDevice({ platform: 'ios' }),
    ),
  );

  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice resolves web through generic inventory without Apple fallback', async () => {
  const result = await withDeviceInventoryProvider(
    async (request) => {
      assert.equal(request.platform, 'web');
      assert.equal(request.deviceName, 'Agent Browser Chrome');
      return [webDesktop];
    },
    async () => await resolveTargetDevice({ platform: 'web', device: 'Agent Browser Chrome' }),
  );

  assert.equal(result.platform, 'web');
  assert.equal(result.id, 'agent-browser-chrome');
  assert.equal(mockFindBootableIosSimulator.mock.calls.length, 0);
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice fast-paths explicit macOS without Apple mobile discovery', async () => {
  const result = await resolveTargetDevice({ platform: 'macos' });

  assert.equal(result.platform, 'apple');
  assert.equal(result.appleOs, 'macos');
  assert.equal(result.id, 'host-macos-local');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice fast-paths Apple desktop target without simulator-set discovery', async () => {
  const result = await resolveTargetDevice({
    platform: 'apple',
    target: 'desktop',
    iosSimulatorDeviceSet: '/tmp/simulators',
  });

  assert.equal(result.platform, 'apple');
  assert.equal(result.appleOs, 'macos');
  assert.equal(result.target, 'desktop');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice fast-path preserves macOS selector validation', async () => {
  await expectDeviceNotFound(() => resolveTargetDevice({ platform: 'macos', udid: 'other-mac' }));

  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

async function expectDeviceNotFound(action: () => Promise<unknown>): Promise<void> {
  const err = await action().catch((error) => error);

  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
}
