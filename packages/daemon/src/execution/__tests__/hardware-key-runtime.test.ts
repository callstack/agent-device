import { createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  hardwareKeyRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { hardwareKeyRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import { deviceShape } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { activateCompleteRefFrame, refFrameState } from '../../core/ref-frame.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../core/request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../../core/generic-leaf-execution.ts';
import { resolveBoundHardwareKeyRuntime } from '../hardware-key-runtime.ts';
import { expectRefusesUnavailableExactOwnerFact } from '../../__tests__/support/runtime-binding-conformance.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

// File-scoped id: the request-router test reaches the on-disk device-claim admission, so a shared
// literal risks a claim collision under parallel test-file execution.
const androidEmulator = {
  id: 'hardware-key-runtime-5554',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
} as const;
const iosSimulator = {
  id: 'hardware-key-runtime-ios-simulator',
  name: 'iPhone',
  platform: 'apple',
  appleOs: 'ios',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const;
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
});

function hardwareKeyExecutionParams(key: string): GenericPlatformExecutionParams {
  const session = makeSession('hardware-key-runtime', { device: androidEmulator });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'hardware-key',
    request: { command: 'hardware-key', positionals: [key], token: 't', session: session.name },
    positionals: [key],
    out: undefined,
    dispatchContext: {},
  };
}

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const hardwareKey = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(androidEmulator), providerMode: 'local' },
    operations: { hardwareKey: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: androidEmulator,
    owner: localRuntimeOwner('android'),
    facts,
    operations: { hardwareKey },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  const bind = vi.fn(async () => binding);
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts,
    bind,
    shutdown: async () => {},
  };
  return { hardwareKey, inspectFacts, bindDevice, bind, gateway };
}

test('resolves one admitted binding and presses the parsed key', async () => {
  const harness = runtimeHarness(
    hardwareKeyRuntimeOperationFacts({ hardwareKey: available }).hardwareKey,
  );

  const resolved = await resolveBoundHardwareKeyRuntime({
    platformServices: daemonPlatformServicesFixture(),
    device: androidEmulator,
    positionals: ['volume-up'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.bindDevice).toHaveBeenCalledWith(androidEmulator, hardwareKeyRuntimeUse);
  expect(await resolved.execute(hardwareKeyExecutionParams('volume-up'))).toEqual({
    action: 'hardware-key',
    key: 'volume-up',
    message: 'Pressed hardware key volume-up',
  });
  expect(harness.hardwareKey).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: 'volume-up' }),
  );
});

test('a raw Android keycode token reaches the operation unchanged', async () => {
  const harness = runtimeHarness();

  const resolved = await resolveBoundHardwareKeyRuntime({
    platformServices: daemonPlatformServicesFixture(),
    device: androidEmulator,
    positionals: ['android-keycode:300'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute(hardwareKeyExecutionParams('android-keycode:300'))).toEqual({
    action: 'hardware-key',
    key: 'android-keycode:300',
    message: 'Pressed hardware key android-keycode:300',
  });
  expect(harness.hardwareKey).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: 'android-keycode:300' }),
  );
});

test.each([
  ['no key', []],
  ['two keys', ['volume-up', 'mute']],
  ['an unknown key', ['volume']],
])('rejects %s before inspection or binding', async (_name, positionals) => {
  const harness = runtimeHarness();

  await expect(
    resolveBoundHardwareKeyRuntime({
      platformServices: daemonPlatformServicesFixture(),
      device: androidEmulator,
      positionals,
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects an iOS simulator through its unavailable exact-owner fact', async () => {
  await expectRefusesUnavailableExactOwnerFact({
    command: 'hardware-key',
    device: iosSimulator,
    unavailable,
  });
});

test('request router joins hardware-key admission to execution and ref invalidation', async () => {
  const harness = runtimeHarness();
  const sessionStore = makeSessionStore('agent-device-hardware-key-generic-');
  const session = makeSession('hardware-key-runtime', { device: androidEmulator });
  activateCompleteRefFrame(session);
  sessionStore.publish(session.name, session);
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: '/tmp/daemon.log',
    token: 't',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: harness.gateway,
    trackDownloadableArtifact: () => 'artifact',
  });

  const response = await handler({
    command: 'hardware-key',
    positionals: ['media-play-pause'],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'hardware-key-router-join' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      action: 'hardware-key',
      key: 'media-play-pause',
      message: 'Pressed hardware key media-play-pause',
    },
  });
  expect(refFrameState(session)).toBe('expired');
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.hardwareKey).toHaveBeenCalledTimes(1);
});
