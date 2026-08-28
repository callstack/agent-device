import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

const { mockFindIosSimulatorInstalledApp, mockListAppleDevices } = vi.hoisted(() => ({
  mockFindIosSimulatorInstalledApp: vi.fn(),
  mockListAppleDevices: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/app-resolution', () => {
  return {
    findIosSimulatorInstalledApp: mockFindIosSimulatorInstalledApp,
  };
});
import {
  resolveTargetDevice as resolveTargetDeviceInContext,
  resolveTargetDeviceSelection as resolveTargetDeviceSelectionInContext,
  withResolveTargetDeviceCacheScope,
} from '../dispatch-resolve.ts';
import {
  withTestDeviceInventory,
  withTestDeviceInventoryProvider as withDeviceInventoryProvider,
} from '../../__tests__/test-utils/device-inventory-gateways.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';

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

const macDesktop: DeviceInfo = {
  platform: 'apple',
  id: 'host-macos-local',
  name: 'Test Mac',
  kind: 'device',
  target: 'desktop',
  appleOs: 'macos',
  booted: true,
};

async function resolveTargetDevice(
  ...args: Parameters<typeof resolveTargetDeviceInContext>
): ReturnType<typeof resolveTargetDeviceInContext> {
  return await withTestDeviceInventory(
    {
      local: async (request) =>
        request.platform === 'macos' ||
        (request.platform === 'apple' && request.target === 'desktop')
          ? [macDesktop]
          : await mockListAppleDevices(request),
    },
    async () => await resolveTargetDeviceInContext(...args),
  );
}

beforeEach(() => {
  mockFindIosSimulatorInstalledApp.mockReset();
  mockFindIosSimulatorInstalledApp.mockResolvedValue(undefined);
  mockListAppleDevices.mockReset();
});

test('resolveTargetDevice narrows local Android discovery to an explicit serial', async () => {
  let requestedInventory: DeviceInventoryRequest | undefined;

  const result = await withDeviceInventoryProvider(
    async (request) => {
      requestedInventory = request;
      return [androidEmulator];
    },
    async () =>
      await resolveTargetDeviceInContext({
        platform: 'android',
        serial: androidEmulator.id,
      }),
  );

  assert.equal(result.id, androidEmulator.id);
  assert.equal(requestedInventory!.serial, androidEmulator.id);
  assert.equal(requestedInventory!.androidSerialAllowlist, undefined);
});

test('resolveTargetDevice does not discover an explicit Android serial outside its allowlist', async () => {
  let requestedInventory: DeviceInventoryRequest | undefined;

  await expectDeviceNotFound(() =>
    withDeviceInventoryProvider(
      async (request) => {
        requestedInventory = request;
        return [];
      },
      async () =>
        await resolveTargetDeviceInContext({
          platform: 'android',
          serial: androidEmulator.id,
          androidDeviceAllowlist: 'emulator-5556',
        }),
    ),
  );

  assert.deepEqual(requestedInventory!.androidSerialAllowlist, ['emulator-5556']);
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

test('app-narrowed selection reports its own typed provenance, not a generic local reason', async () => {
  // Two booted simulators, the app installed on exactly one: the resolver owns
  // the narrowing, so the metadata must say so instead of `preferred-local`
  // computed against the unnarrowed inventory.
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);
  mockFindIosSimulatorInstalledApp.mockImplementation(async (device) =>
    device.id === secondBootedSimulator.id ? 'com.example.demo' : undefined,
  );

  const selection = await withTestDeviceInventory(
    { local: async (request) => await mockListAppleDevices(request) },
    async () =>
      await resolveTargetDeviceSelectionInContext(
        { platform: 'ios' },
        { appleSimulatorAppTarget: 'com.example.demo' },
      ),
  );

  assert.equal(selection.device.id, secondBootedSimulator.id);
  assert.equal(selection.reason, 'single-app-installed-local');
  assert.equal(selection.source, 'local');
  assert.equal(selection.candidateCount, 1);
});

test('resolveTargetDevice leaves platform-less static app selection to normal cross-platform resolution', async () => {
  // One booted device: cross-platform resolution answers without probing simulators for the app.
  const result = await withDeviceInventoryProvider(
    async (request) => {
      assert.equal(request.platform, undefined);
      return [androidEmulator];
    },
    async () =>
      await resolveTargetDeviceInContext({}, { appleSimulatorAppTarget: 'com.example.demo' }),
  );

  assert.equal(result.id, androidEmulator.id);
  assert.equal(mockFindIosSimulatorInstalledApp.mock.calls.length, 0);
});

test('platform-less resolution refuses to pick between equally booted devices', async () => {
  // Three booted devices and no identity: the previous winner was simply the first in discovery
  // order, so a caller could get a successful answer about a device they never selected.
  const error = await withDeviceInventoryProvider(
    async () => [androidEmulator, bootedSimulator, secondBootedSimulator],
    async () => {
      try {
        await resolveTargetDeviceInContext({}, { appleSimulatorAppTarget: 'com.example.demo' });
      } catch (error) {
        return error;
      }
      throw new assert.AssertionError({
        message: 'expected ambiguous device resolution to refuse',
      });
    },
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'AMBIGUOUS_MATCH');
  const listed = (error.details?.devices ?? []) as Array<{ id: string }>;
  assert.deepEqual(
    listed.map((device) => device.id),
    [androidEmulator.id, bootedSimulator.id, secondBootedSimulator.id],
  );
  assert.match(String(error.details?.hint ?? ''), /--serial emulator-5554|--device/);
  assert.equal(mockFindIosSimulatorInstalledApp.mock.calls.length, 0);
});

test('resolveTargetDevice reuses an app-aware iOS selection for later iOS resolution', async () => {
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
  ).catch((error) => error);

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'APP_NOT_INSTALLED');
  assert.match(error.message, /No booted iOS simulator has com\.example\.demo installed/);
  // Keyed `devices`, not `candidates`: the find handler's element matches own
  // that key with an incompatible shape (src/utils/error-candidates.ts).
  assert.equal(error.details?.candidates, undefined);
  assert.deepEqual(error.details?.devices, [
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
  ).catch((error) => error);

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'AMBIGUOUS_MATCH');
  assert.match(error.message, /Multiple booted iOS simulators have com\.example\.demo installed/);
  assert.equal(error.details?.hint, 'Pass --udid to select the intended simulator explicitly.');
  assert.deepEqual(error.details?.devices, [
    { id: bootedSimulator.id, name: bootedSimulator.name },
    { id: secondBootedSimulator.id, name: secondBootedSimulator.name },
  ]);
});

test('resolveTargetDevice preserves an explicit device selector when platform is omitted', async () => {
  mockListAppleDevices.mockResolvedValue([bootedSimulator, secondBootedSimulator]);

  const result = await resolveTargetDevice(
    { udid: bootedSimulator.id },
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
    async () => await resolveTargetDeviceInContext({ platform: 'ios', device: 'Remote iPhone' }),
  );

  assert.equal(result.id, 'remote-ios-1');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice preserves physical-device backend evidence from injected inventory', async () => {
  const result = await withDeviceInventoryProvider(
    async () => [{ ...physical, iosPhysicalDeviceBackend: 'xctest' }],
    async () => await resolveTargetDeviceInContext({ platform: 'ios', udid: physical.id }),
  );

  assert.equal(result.iosPhysicalDeviceBackend, 'xctest');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDeviceSelection reports one candidate for an explicit Apple identity', async () => {
  const selection = await withDeviceInventoryProvider(
    async () => [physical, bootedSimulator],
    async () => await resolveTargetDeviceSelectionInContext({ platform: 'ios', udid: physical.id }),
  );

  assert.equal(selection.device.id, physical.id);
  assert.equal(selection.reason, 'explicit-selector');
  assert.equal(selection.candidateCount, 1);
});

test('platform-only local selection reports inferred precedence instead of explicit identity', async () => {
  const selection = await withTestDeviceInventory(
    {
      local: async () => [bootedSimulator, simulator],
    },
    async () => await resolveTargetDeviceSelectionInContext({ platform: 'ios' }),
  );

  assert.equal(selection.device.id, bootedSimulator.id);
  assert.equal(selection.reason, 'single-booted-local');
  assert.equal(selection.source, 'local');
});

test('platform-only provider selection reports provider inference', async () => {
  const selection = await withTestDeviceInventory(
    {
      provider: {
        discover: async () => ({ kind: 'inventory', devices: [physical] }),
      },
      local: async () => {
        throw new Error('provider inventory should not fall back to local discovery');
      },
    },
    async () => await resolveTargetDeviceSelectionInContext({ platform: 'ios' }),
  );

  assert.equal(selection.device.id, physical.id);
  assert.equal(selection.reason, 'single-provider-device');
  assert.equal(selection.source, 'provider');
});

test('resolveTargetDevice preserves Apple simulator preference with injected inventory', async () => {
  const result = await withTestDeviceInventory(
    {
      provider: {
        discover: async () => ({ kind: 'declined' }),
      },
      local: async () => [simulator],
    },
    async () => await resolveTargetDeviceInContext({ platform: 'ios' }),
  );

  assert.equal(result.id, 'sim-1');
  assert.equal(result.kind, 'simulator');
  assert.equal(mockListAppleDevices.mock.calls.length, 0);
});

test('resolveTargetDevice keeps provider Apple inventory isolated from local fallback', async () => {
  const localDiscover = vi.fn(async () => [simulator]);

  const result = await withTestDeviceInventory(
    {
      provider: {
        discover: async (request) => {
          assert.equal(request.platform, 'ios');
          return { kind: 'inventory', devices: [physical] };
        },
      },
      local: localDiscover,
    },
    async () => await resolveTargetDeviceInContext({ platform: 'ios' }),
  );

  assert.equal(result.id, physical.id);
  assert.equal(localDiscover.mock.calls.length, 0);
});

test('resolveTargetDevice propagates cancellation from the local Apple simulator probe', async () => {
  const canceled = new AppError('COMMAND_FAILED', 'request canceled', {
    reason: 'request_canceled',
  });
  let localCalls = 0;

  await assert.rejects(
    withTestDeviceInventory(
      {
        local: async () => {
          if (localCalls++ === 0) return [physical];
          throw canceled;
        },
      },
      async () => await resolveTargetDeviceInContext({ platform: 'ios' }),
    ),
    (error) => error === canceled,
  );
});

test('resolveTargetDevice propagates missing inventory wiring from the local Apple simulator probe', async () => {
  const unavailable = new AppError(
    'COMMAND_FAILED',
    'Device inventory gateway is unavailable outside request execution',
    { reason: 'device_inventory_context_unavailable' },
  );
  let localCalls = 0;

  await assert.rejects(
    withTestDeviceInventory(
      {
        local: async () => {
          if (localCalls++ === 0) return [physical];
          throw unavailable;
        },
      },
      async () => await resolveTargetDeviceInContext({ platform: 'ios' }),
    ),
    (error) => error === unavailable,
  );
});

test('resolveTargetDevice keeps genuine local Apple simulator probe failures best-effort', async () => {
  let localCalls = 0;
  const result = await withTestDeviceInventory(
    {
      local: async () => {
        if (localCalls++ === 0) return [physical];
        throw new Error('simctl timed out');
      },
    },
    async () => await resolveTargetDeviceInContext({ platform: 'ios' }),
  );

  assert.equal(result.id, physical.id);
});

test('resolveTargetDevice treats empty injected inventory as authoritative', async () => {
  await expectDeviceNotFound(() =>
    withDeviceInventoryProvider(
      async () => [],
      async () => await resolveTargetDeviceInContext({ platform: 'ios' }),
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
    async () =>
      await resolveTargetDeviceInContext({
        platform: 'web',
        device: 'Agent Browser Chrome',
      }),
  );

  assert.equal(result.platform, 'web');
  assert.equal(result.id, 'agent-browser-chrome');
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

test('resolveTargetDevice keeps simulator-set scope separate from the macOS host target', async () => {
  const requests: DeviceInventoryRequest[] = [];
  await withTestDeviceInventory(
    {
      local: async (request) => {
        requests.push(request);
        return request.platform === 'macos' ? [macDesktop] : [simulator];
      },
    },
    async () => {
      const simulatorResult = await resolveTargetDeviceInContext({
        platform: 'ios',
        iosSimulatorDeviceSet: '/tmp/isolated-set',
      });
      const macResult = await resolveTargetDeviceInContext({
        platform: 'macos',
        iosSimulatorDeviceSet: '/tmp/isolated-set',
      });
      assert.equal(simulatorResult.id, simulator.id);
      assert.equal(macResult.id, macDesktop.id);
    },
  );

  assert.equal(requests[0]?.iosSimulatorSetPath, '/tmp/isolated-set');
  assert.equal(requests[1]?.iosSimulatorSetPath, undefined);
});

async function expectDeviceNotFound(action: () => Promise<unknown>): Promise<void> {
  const err = await action().catch((error) => error);

  assert.ok(err instanceof AppError);
  assert.equal(err.code, 'DEVICE_NOT_FOUND');
}
