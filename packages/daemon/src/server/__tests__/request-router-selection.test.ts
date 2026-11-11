import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { canonicalLocalDeviceKey } from '@agent-device/daemon-contracts/device-claims';
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
  deviceRuntimeGateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = lifecycleDeviceRuntimeGateway,
) {
  const sessionStore = makeSessionStore('agent-device-router-selection-');
  const inspectFacts = vi.fn(deviceRuntimeGateway.inspectFacts);
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
        return request.androidAvdSelection === 'running-only'
          ? devices.filter((device) => device.platform !== 'android' || device.booted === true)
          : devices;
      },
    }),
    deviceRuntimeGateway: { ...deviceRuntimeGateway, inspectFacts },
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

test.each(['boot', 'shutdown', 'capabilities', 'apps', 'open'] as const)(
  '%s keeps stopped-AVD selection consistent through request admission',
  async (command) => {
    const inventoryRequests: Array<{ platform?: string; androidAvdSelection?: string }> = [];
    const stopped = { ...android, id: android.name, booted: false };
    const { handler, inspectFacts } = selectionHandler([stopped], inventoryRequests);
    const selected = await handler({
      token: 'test-token',
      session: 'no-session',
      command,
      positionals: [],
      flags: { platform: 'android', device: stopped.name },
      meta: { requestId: `${command}-stopped` },
    });
    expect(
      inventoryRequests.length > 0 &&
        inventoryRequests.every((request) => request.androidAvdSelection === 'include-stopped'),
    ).toBe(true);
    if (!selected.ok) expect(selected.error.code).not.toBe('DEVICE_NOT_FOUND');
    expect(inspectFacts).toHaveBeenCalledWith(stopped);
    const factsBeforeInvalid = inspectFacts.mock.calls.length;

    const invalid = await handler({
      token: 'test-token',
      session: 'no-session',
      command,
      positionals: [],
      flags: { platform: 'android', device: 'missing-avd' },
      meta: { requestId: `${command}-missing` },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'DEVICE_NOT_FOUND' } });
    expect(inspectFacts).toHaveBeenCalledTimes(factsBeforeInvalid);
  },
);

/** The lifecycle gateway plus a local readiness operation that boots a stopped AVD to `booted`. */
function bootingLifecycleGateway(booted: DeviceInfo) {
  const ensureReady = vi.fn(async () => booted);
  const ready = Object.freeze({ available: true as const });
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async (device) => {
      const facts = await lifecycleDeviceRuntimeGateway.inspectFacts(device);
      return { ...facts, operations: { ...facts.operations, ensureReady: ready } };
    },
    bind: async (request) => {
      const binding = await lifecycleDeviceRuntimeGateway.bind(request);
      return {
        ...binding,
        facts: {
          ...binding.facts,
          operations: { ...binding.facts.operations, ensureReady: ready },
        },
        operations: { ...binding.operations, ensureReady },
      };
    },
    shutdown: async () => {},
  };
  return { gateway, ensureReady };
}

test('open boots a stopped AVD and keys the session and its claim on the booted serial', async () => {
  const inventoryRequests: Array<{ platform?: string; androidAvdSelection?: string }> = [];
  const stopped = { ...android, id: android.name, booted: false };
  const { gateway, ensureReady } = bootingLifecycleGateway(android);
  const { handler, sessionStore } = selectionHandler([stopped], inventoryRequests, gateway);

  const opened = await handler({
    token: 'test-token',
    session: 'cold-avd',
    command: 'open',
    positionals: ['com.android.settings'],
    flags: { platform: 'android', device: stopped.name },
    meta: { requestId: 'open-cold-avd' },
  });

  expect(opened).toMatchObject({ ok: true });
  expect(ensureReady).toHaveBeenCalledTimes(1);
  const session = sessionStore.get('cold-avd');
  expect(session?.device).toMatchObject({ id: android.id, booted: true });
  expect(session?.deviceClaim?.deviceKey).toBe(canonicalLocalDeviceKey(android));
});
