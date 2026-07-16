import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  configureProviderPortReverse,
  getProviderDeviceInteractor,
  installProviderDeviceApp,
  removeProviderPortReverse,
  setActiveProviderDeviceRuntimes,
  type ProviderDeviceRuntime,
} from '../provider-device-runtime.ts';
import type { Interactor } from '../core/interactor-types.ts';
import type { SimulatorLease } from '../daemon/lease-registry.ts';
import type { DeviceInfo } from '../kernel/device.ts';

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

test('provider device runtime registry delegates lifecycle, inventory, interactors, and installs to matching providers', async () => {
  const world = makeProviderRuntimeWorld();
  setActiveProviderDeviceRuntimes([world.missRuntime, world.hitRuntime]);
  const requestProviders = createProviderDeviceRuntimeRequestProviders([
    world.missRuntime,
    world.hitRuntime,
  ]);

  assert.deepEqual(await requestProviders.leaseLifecycleProvider?.allocate?.(world.lease), {
    provider: 'hit',
  });
  assert.deepEqual(
    await requestProviders.deviceInventoryProvider?.({
      platform: 'ios',
      leaseId: world.lease.leaseId,
      leaseProvider: 'hit',
    }),
    [world.device],
  );
  await assertProviderRuntimeDelegates(world);
});

function makeProviderRuntimeWorld() {
  const lease: SimulatorLease = {
    leaseId: 'lease-a',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'hit',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
  const device: DeviceInfo = {
    platform: 'apple',
    kind: 'simulator',
    id: 'provider:ios:lease-a',
    name: 'Provider iOS',
    booted: true,
  };
  const interactor = { open: async () => undefined } as unknown as Interactor;
  const missRuntime = makeMissingRuntime();
  const hitRuntime = makeRuntime({
    provider: 'hit',
    leaseResult: { provider: 'hit' },
    devices: [device],
    interactor,
    installResult: { bundleId: 'com.example.app' },
    portReverseResult: { provider: 'hit' },
  });
  return { lease, device, interactor, missRuntime, hitRuntime };
}

function makeMissingRuntime(): ProviderDeviceRuntime {
  return makeRuntime({
    provider: 'miss',
    leaseResult: undefined,
    devices: null,
    interactor: undefined,
    installResult: undefined,
    portReverseResult: undefined,
  });
}

async function assertProviderRuntimeDelegates(world: ReturnType<typeof makeProviderRuntimeWorld>) {
  assert.equal(getProviderDeviceInteractor(world.device), world.interactor);
  assert.deepEqual(
    await installProviderDeviceApp(world.device, 'com.example.app', '/tmp/app.ipa'),
    {
      bundleId: 'com.example.app',
    },
  );
  assert.deepEqual(
    await configureProviderPortReverse({
      leaseId: world.lease.leaseId,
      provider: 'hit',
      devicePort: 8097,
      hostPort: 8097,
      name: 'devtools',
    }),
    { provider: 'hit' },
  );
  assert.deepEqual(
    await removeProviderPortReverse({
      leaseId: world.lease.leaseId,
      provider: 'hit',
      devicePort: 8097,
      hostPort: 8097,
      name: 'devtools',
    }),
    { provider: 'hit' },
  );
}

test('provider device install fails explicitly when an owning provider has no install hook', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    kind: 'device',
    id: 'provider:android:lease-a',
    name: 'Provider Android',
    booted: true,
  };
  const runtime = makeRuntime({
    provider: 'hit',
    leaseResult: undefined,
    devices: [device],
    interactor: undefined,
    installResult: undefined,
    portReverseResult: undefined,
    installHook: false,
  });
  setActiveProviderDeviceRuntimes([runtime]);

  await assert.rejects(
    () => installProviderDeviceApp(device, 'com.example.app', '/tmp/app.apk'),
    /does not support install/,
  );
});

function makeRuntime(options: {
  provider: string;
  leaseResult: Record<string, unknown> | undefined;
  devices: DeviceInfo[] | null;
  interactor: Interactor | undefined;
  installResult: { bundleId: string } | undefined;
  portReverseResult: Record<string, unknown> | undefined;
  installHook?: boolean;
}): ProviderDeviceRuntime {
  return {
    provider: options.provider,
    leaseLifecycle: {
      allocate: async () => options.leaseResult,
      heartbeat: async () => options.leaseResult,
      release: async () => options.leaseResult,
    },
    deviceInventoryProvider: async () => options.devices,
    ownsDevice: (device) => options.devices?.some((entry) => entry.id === device.id) ?? false,
    getInteractor: () => options.interactor,
    ...(options.installHook === false ? {} : { installApp: async () => options.installResult }),
    configurePortReverse: async () => options.portReverseResult,
    removePortReverse: async () => options.portReverseResult,
    shutdown: async () => undefined,
  };
}
