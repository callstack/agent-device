import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import {
  createRequestHandler,
  lifecycleDeviceRuntimeGateway,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';

const ios: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'SIM-FOREGROUND',
  name: 'iPhone',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};
const android: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel_9',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

function selectionHandler(
  devices: readonly DeviceInfo[],
  inventoryRequests: Array<{ platform?: string; androidAvdSelection?: string }>,
) {
  const sessionStore = makeSessionStore('agent-device-router-selection-');
  const inspectFacts = vi.fn(lifecycleDeviceRuntimeGateway.inspectFacts);
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async (request) => {
        inventoryRequests.push(request);
        return devices;
      },
    }),
    deviceRuntimeGateway: { ...lifecycleDeviceRuntimeGateway, inspectFacts },
    platformServices: daemonPlatformServicesFixture({
      appleSessionObservation: {
        observeRunnerSession: async () => undefined,
        resolveSoleForegroundApp: async () => ({
          device: ios,
          app: { bundleId: 'com.example.foreground' },
        }),
      },
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, sessionStore, inspectFacts };
}

test('fresh no-app foreground open selects iOS from mixed Android and iOS inventory', async () => {
  const inventoryRequests: Array<{ platform?: string; androidAvdSelection?: string }> = [];
  const { handler, sessionStore } = selectionHandler([android, ios], inventoryRequests);
  await handler({
    token: 'test-token',
    session: 'foreground',
    command: 'open',
    positionals: [],
    flags: { foreground: true },
    meta: { requestId: 'foreground-mixed' },
  });
  expect(inventoryRequests.length).toBeGreaterThan(0);
  expect(inventoryRequests.map((request) => request.platform)).toEqual(['ios']);
  expect(sessionStore.get('foreground')?.device.id).toBe(ios.id);
});

test('shutdown selects a stopped Android AVD and rejects an invalid selector before facts', async () => {
  const inventoryRequests: Array<{ platform?: string; androidAvdSelection?: string }> = [];
  const stopped = { ...android, booted: false };
  const { handler, inspectFacts } = selectionHandler([stopped], inventoryRequests);
  const selected = await handler({
    token: 'test-token',
    session: 'no-session',
    command: 'shutdown',
    positionals: [],
    flags: { platform: 'android', device: stopped.name },
    meta: { requestId: 'shutdown-stopped' },
  });
  expect(
    inventoryRequests.some((request) => request.androidAvdSelection === 'include-stopped'),
  ).toBe(true);
  if (!selected.ok) expect(selected.error.code).not.toBe('DEVICE_NOT_FOUND');
  expect(inspectFacts).toHaveBeenCalledWith(stopped);
  const factsBeforeInvalid = inspectFacts.mock.calls.length;

  const invalid = await handler({
    token: 'test-token',
    session: 'no-session',
    command: 'shutdown',
    positionals: [],
    flags: { platform: 'android', device: 'missing-avd' },
    meta: { requestId: 'shutdown-missing' },
  });
  expect(invalid).toMatchObject({ ok: false, error: { code: 'DEVICE_NOT_FOUND' } });
  expect(inspectFacts).toHaveBeenCalledTimes(factsBeforeInvalid);
});
