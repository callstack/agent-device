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
  homeRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { SystemButton } from '@agent-device/contracts/system-button-runtime';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { activateCompleteRefFrame, refFrameState } from '../ref-frame.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import {
  resolveBoundSystemButtonRuntime,
  type SystemButtonCommand,
} from '../system-button-runtime.ts';
import {
  expectRefusesUnavailableExactOwnerFact,
  systemButtonCommands,
} from './runtime-binding-conformance.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

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
  sessionStore.set(session.name, session);
  const handler = createRequestHandler({
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
