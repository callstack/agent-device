import { createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { expect, test, vi } from 'vitest';
import { systemButtonRuntimeOperationFacts } from '@agent-device/contracts/system-button-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  actionButtonRuntimeUse,
  appSwitcherRuntimeUse,
  hardwareKeyRuntimeUse,
  homeRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { SystemButton } from '@agent-device/contracts/system-button-runtime';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
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
import {
  resolveBoundHardwareKeyRuntime,
  resolveBoundSystemButtonRuntime,
  type SystemButtonCommand,
} from '../system-button-runtime.ts';
import {
  expectRefusesUnavailableExactOwnerFact,
  systemButtonCommands,
} from '../../__tests__/support/runtime-binding-conformance.ts';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

const macOsDevice = {
  id: 'macos-host',
  name: 'Mac',
  platform: 'apple',
  appleOs: 'macos',
  kind: 'device',
  target: 'desktop',
  booted: true,
} as const;
const iosSimulator = {
  id: 'system-button-runtime-ios-simulator',
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

/**
 * What each command must bind and report, stated here rather than read back from the production
 * table, so a row that drifts (wrong use, wrong text) fails instead of proving itself.
 */
const EXPECTED: Record<
  SystemButtonCommand,
  { button: SystemButton; use: unknown; message: string; refusedOn: DeviceInfo }
> = {
  home: { button: 'home', use: homeRuntimeUse, message: 'Home', refusedOn: macOsDevice },
  'app-switcher': {
    button: 'appSwitcher',
    use: appSwitcherRuntimeUse,
    message: 'Opened app switcher',
    refusedOn: iosSimulator,
  },
  'action-button': {
    button: 'actionButton',
    use: actionButtonRuntimeUse,
    message: 'Pressed Action Button',
    refusedOn: iosSimulator,
  },
};

test('the registry names exactly the commands the press route serves', () => {
  expect([...systemButtonCommands].sort()).toEqual(Object.keys(EXPECTED).sort());
});

function executionParams(
  command: SystemButtonCommand,
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  const session = makeSession('system-button-runtime', { device: iosSimulator });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command,
    request: { command, positionals: [], token: 't', session: session.name },
    positionals: [],
    out: undefined,
    dispatchContext,
  };
}

function runtimeHarness(button: SystemButton, fact: RuntimeOperationFact = available) {
  const press = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(iosSimulator), providerMode: 'local' },
    operations: systemButtonRuntimeOperationFacts({
      unsupported: unavailable,
      [button]: fact,
    }) as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: iosSimulator,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: { [button]: press },
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
  return { press, inspectFacts, bindDevice, bind, gateway };
}

test.each(Object.keys(EXPECTED) as SystemButtonCommand[])(
  '%s resolves one admitted binding and presses its button once',
  async (command) => {
    const expected = EXPECTED[command];
    const harness = runtimeHarness(expected.button);

    const resolved = await resolveBoundSystemButtonRuntime(command, {
      platformServices: daemonPlatformServicesFixture(),
      device: iosSimulator,
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
    expect(harness.bindDevice).toHaveBeenCalledWith(iosSimulator, expected.use);
    expect(await resolved.execute(executionParams(command))).toEqual({
      action: command,
      message: expected.message,
    });
    expect(harness.press).toHaveBeenCalledTimes(1);
  },
);

test.each(Object.keys(EXPECTED) as SystemButtonCommand[])(
  '%s rejects an unavailable exact-owner fact before binding',
  async (command) => {
    await expectRefusesUnavailableExactOwnerFact({
      command,
      device: EXPECTED[command].refusedOn,
      unavailable,
    });
  },
);

test('request router joins home admission to execution, recording, and ref invalidation', async () => {
  const harness = runtimeHarness('home');
  const sessionStore = makeSessionStore('agent-device-home-generic-');
  const session = makeSession('system-button-runtime', { device: iosSimulator });
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
    command: 'home',
    positionals: [],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'home-router-join' },
  });

  expect(response).toMatchObject({ ok: true, data: { action: 'home', message: 'Home' } });
  expect(refFrameState(session)).toBe('expired');
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.press).toHaveBeenCalledTimes(1);
});

// File-scoped id: the request-router test reaches the on-disk device-claim admission, so a shared
// literal risks a claim collision under parallel test-file execution.
const androidEmulator = {
  id: 'system-button-runtime-hardware-key-5554',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
} as const;

function hardwareKeyHarness() {
  const hardwareKey = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(androidEmulator), providerMode: 'local' },
    operations: systemButtonRuntimeOperationFacts({
      unsupported: unavailable,
      hardwareKey: available,
    }) as RuntimeFacts<PlatformRuntimeOperations>['operations'],
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

test('hardware-key resolves one admitted binding and presses the parsed key', async () => {
  const harness = hardwareKeyHarness();

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
  const session = makeSession('system-button-runtime', { device: androidEmulator });
  expect(
    await resolved.execute({
      session,
      sessionName: session.name,
      logPath: '/tmp/daemon.log',
      command: 'hardware-key',
      request: {
        command: 'hardware-key',
        positionals: ['volume-up'],
        token: 't',
        session: session.name,
      },
      positionals: ['volume-up'],
      out: undefined,
      dispatchContext: {},
    }),
  ).toEqual({
    action: 'hardware-key',
    key: 'volume-up',
    message: 'Pressed hardware key volume-up',
  });
  expect(harness.hardwareKey).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: 'volume-up' }),
  );
});

test.each([
  ['no key', []],
  ['two keys', ['volume-up', 'mute']],
  ['an unknown key', ['volume']],
])('hardware-key rejects %s before inspection or binding', async (_name, positionals) => {
  const harness = hardwareKeyHarness();

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

test('hardware-key rejects an iOS simulator through its unavailable exact-owner fact', async () => {
  await expectRefusesUnavailableExactOwnerFact({
    command: 'hardware-key',
    device: iosSimulator,
    unavailable,
  });
});

test('request router joins hardware-key admission to execution and ref invalidation', async () => {
  const harness = hardwareKeyHarness();
  const sessionStore = makeSessionStore('agent-device-hardware-key-generic-');
  const session = makeSession('system-button-runtime', { device: androidEmulator });
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
