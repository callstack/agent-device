import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import {
  createProviderDeviceRuntimeRequestProviders,
  getProviderDeviceInteractor,
  setActiveProviderDeviceRuntimes,
} from '../provider-device-runtime.ts';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { SimulatorLease } from '../daemon/lease-registry.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppleRunnerScreenRecordingTransport } from '../platform-runtime-screen-recording-apple-runner-transport.ts';

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

test('provider device runtime registry delegates lifecycle, inventory, and interactors to matching providers', async () => {
  const world = makeProviderRuntimeWorld();
  setActiveProviderDeviceRuntimes([world.missRuntime, world.hitRuntime]);
  const requestProviders = createProviderDeviceRuntimeRequestProviders([
    world.missRuntime,
    world.hitRuntime,
  ]);

  assert.deepEqual(await requestProviders.leaseLifecycleProvider?.allocate?.(world.lease), {
    provider: 'hit',
  });
  await requestProviders.recoverExpiredLease?.(world.lease);
  assert.deepEqual(requestProviders.recoverableProviderIds, ['hit']);
  assert.deepEqual(world.recoveredLeases, [world.lease]);
  assert.deepEqual(
    await requestProviders.deviceInventorySource?.discover(
      {
        platform: 'ios',
        leaseId: world.lease.leaseId,
        leaseProvider: 'hit',
      },
      new AbortController().signal,
    ),
    { kind: 'inventory', devices: [world.device] },
  );
  assert.equal(getProviderDeviceInteractor(world.device), world.interactor);
});

test('provider device runtime registry rejects duplicate provider owners', () => {
  const first = makeMissingRuntime();
  const second = makeMissingRuntime();
  assert.throws(
    () => createProviderDeviceRuntimeRequestProviders([first, second]),
    /Duplicate provider device runtime: miss/,
  );
});

test('provider device runtime composition exposes focused runner recording authority only for its exact device', () => {
  const device: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    kind: 'device',
    target: 'desktop',
    id: 'provider:macos:lease-a',
    name: 'Provider Mac',
    booted: true,
  };
  const transport: AppleRunnerScreenRecordingTransport = Object.freeze({
    authority: 'scoped-provider',
    available: true,
    start: async () => ({ runnerSessionId: 'external-session-1' }),
    inspect: async (_device, runnerSessionId) =>
      runnerSessionId === 'external-session-1' ? 'owned-alive' : 'ownership-lost',
    stop: async () => undefined,
  });
  const runtime = {
    ...makeRuntime({
      provider: 'mac-provider',
      leaseResult: undefined,
      devices: [device],
      interactor: undefined,
      portReverseResult: undefined,
    }),
    getAppleRunnerScreenRecordingTransport: (candidate: DeviceInfo) =>
      candidate.id === device.id ? transport : undefined,
  };
  const resolver = createProviderDeviceRuntimeRequestProviders([
    runtime,
  ]).appleRunnerScreenRecordingTransport;
  const req = { token: 'token', session: 'default', command: 'record', positionals: [], flags: {} };

  assert.equal(resolver?.({ req, device }), transport);
  assert.equal(
    resolver?.({ req, device: { ...device, id: 'provider:macos:replacement' } }),
    undefined,
  );
});

test('provider inventory composition forwards cancellation into the legacy provider callback', async () => {
  let observedSignal: AbortSignal | undefined;
  const runtime: ProviderDeviceRuntime = {
    ...makeMissingRuntime(),
    deviceInventoryProvider: async (_request, signal) => {
      observedSignal = signal;
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  };
  const source = createProviderDeviceRuntimeRequestProviders([runtime]).deviceInventorySource;
  const controller = new AbortController();
  const pending = source?.discover({ leaseProvider: 'miss' }, controller.signal);
  controller.abort(new Error('provider request cancelled'));

  await assert.rejects(() => pending!, /provider request cancelled/);
  assert.equal(observedSignal, controller.signal);
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
  const recoveredLeases: SimulatorLease[] = [];
  const missRuntime = makeMissingRuntime();
  const hitRuntime = makeRuntime({
    provider: 'hit',
    leaseResult: { provider: 'hit' },
    devices: [device],
    interactor,
    portReverseResult: { provider: 'hit' },
  });
  hitRuntime.recoverExpiredLease = async (expiredLease) => {
    recoveredLeases.push(expiredLease);
  };
  return { lease, device, interactor, missRuntime, hitRuntime, recoveredLeases };
}

function makeMissingRuntime(): ProviderDeviceRuntime {
  return makeRuntime({
    provider: 'miss',
    leaseResult: undefined,
    devices: null,
    interactor: undefined,
    portReverseResult: undefined,
  });
}

function makeRuntime(options: {
  provider: string;
  leaseResult: Record<string, unknown> | undefined;
  devices: DeviceInfo[] | null;
  interactor: Interactor | undefined;
  portReverseResult: Record<string, unknown> | undefined;
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
    configurePortReverse: async () => options.portReverseResult,
    shutdown: async () => undefined,
  };
}
