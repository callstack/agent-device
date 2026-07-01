import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockFindBootableIosSimulator, mockListAppleDevices } = vi.hoisted(() => ({
  mockFindBootableIosSimulator: vi.fn(),
  mockListAppleDevices: vi.fn(),
}));

vi.mock('../../platforms/apple/core/devices.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/devices.ts')>();
  return {
    ...actual,
    findBootableIosSimulator: mockFindBootableIosSimulator,
    listAppleDevices: mockListAppleDevices,
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

const webDesktop: DeviceInfo = {
  platform: 'web',
  id: 'agent-browser-chrome',
  name: 'Agent Browser Chrome',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

beforeEach(() => {
  mockFindBootableIosSimulator.mockReset();
  mockFindBootableIosSimulator.mockResolvedValue(null);
  mockListAppleDevices.mockReset();
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
