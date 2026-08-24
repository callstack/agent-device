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
  tvRemoteRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { tvRemoteRuntimeOperationFacts } from '@agent-device/contracts/tv-remote-runtime';
import { deviceShape } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import { resolveBoundTvRemoteRuntime } from '../tv-remote-runtime.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

const vegaVvd = {
  id: 'vega-vvd',
  name: 'Vega VVD',
  platform: 'vega',
  kind: 'emulator',
  target: 'tv',
  booted: true,
} as const;
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind' as const,
  hint: 'tv-remote currently supports only Vega Virtual Devices.',
});

function tvRemoteExecutionParams(
  positionals: string[],
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  const session = makeSession('tv-remote-runtime', { device: vegaVvd });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'tv-remote',
    request: { command: 'tv-remote', positionals, token: 't', session: session.name },
    positionals,
    out: undefined,
    dispatchContext,
  };
}

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const tvRemote = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(vegaVvd), providerMode: 'local' },
    operations: { tvRemote: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: vegaVvd,
    owner: localRuntimeOwner('vega'),
    facts,
    operations: { tvRemote },
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
  return { tvRemote, inspectFacts, bindDevice, bind, gateway };
}

test('resolves one admitted binding and presses one remote button', async () => {
  const harness = runtimeHarness(tvRemoteRuntimeOperationFacts({ tvRemote: available }).tvRemote);

  const resolved = await resolveBoundTvRemoteRuntime({
    device: vegaVvd,
    positionals: ['down'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.bindDevice).toHaveBeenCalledWith(vegaVvd, tvRemoteRuntimeUse);
  expect(await resolved.execute(tvRemoteExecutionParams(['down']))).toEqual({
    action: 'tv-remote',
    button: 'down',
    message: 'Pressed TV remote down',
  });
  expect(harness.tvRemote).toHaveBeenCalledWith(
    expect.objectContaining({ button: 'down', durationMs: undefined }),
  );
});

test('forwards a validated duration and reports it in the response', async () => {
  const harness = runtimeHarness();

  const resolved = await resolveBoundTvRemoteRuntime({
    device: vegaVvd,
    positionals: ['select'],
    durationMs: 500,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute(tvRemoteExecutionParams(['select']))).toEqual({
    action: 'tv-remote',
    button: 'select',
    durationMs: 500,
    message: 'Pressed TV remote select',
  });
  expect(harness.tvRemote).toHaveBeenCalledWith(
    expect.objectContaining({ button: 'select', durationMs: 500 }),
  );
});

test('rejects an out-of-range duration before inspection or binding', async () => {
  const harness = runtimeHarness();

  await expect(
    resolveBoundTvRemoteRuntime({
      device: vegaVvd,
      positionals: ['down'],
      durationMs: 50_000,
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toThrow();
  expect(harness.inspectFacts).not.toHaveBeenCalled();
});

test('rejects a missing button before inspection or binding', async () => {
  const harness = runtimeHarness();

  await expect(
    resolveBoundTvRemoteRuntime({
      device: vegaVvd,
      positionals: [],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundTvRemoteRuntime({
    device: vegaVvd,
    positionals: ['down'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'tv-remote is not supported on this device',
        hint: unavailable.hint,
      },
    },
  });
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

// Pins the wire response for a non-TV target on the two platforms that keep their own capability
// hint text (`packages/platform-apple/src/runtime.test.ts` and
// `packages/platform-android/src/runtime.test.ts` prove these are the exact strings those owners'
// facts produce). Before this migration, the daemon's own generic capability gate
// (`requireCommandSupported(command, device, { hint: true })` in the retired
// `ensureGenericCommandReady`) produced the identical shape — a generic "<command> is not
// supported on this device" message plus the owner-specific hint — for every device that reached
// dispatch; `handleTvRemoteCommand`'s own internal `device.target !== 'tv'` check with the unified
// "supported only on TV targets" message was unreachable from that gate and only ever exercised by
// a test calling `dispatchCommand` directly, bypassing the daemon layer entirely.
test.each([
  [
    'iOS simulator (not tvOS)',
    { id: 'ios-sim', name: 'iPhone', platform: 'apple', kind: 'simulator', booted: true } as const,
    'tv-remote is supported only on tvOS devices.',
  ],
  [
    'Android emulator (mobile target)',
    {
      // File-scoped id, not the widely shared 'emulator-5554' literal: this owner binding's
      // `local-family` kind reaches the real on-disk device-claim admission (`require-owner`
      // policy), so a shared id risks a cross-file claim collision under parallel test-file
      // execution.
      id: 'tv-remote-runtime-5554',
      name: 'Pixel',
      platform: 'android',
      kind: 'emulator',
      target: 'mobile',
      booted: true,
    } as const,
    'tv-remote is supported only on Android TV targets.',
  ],
])(
  'rejects %s with its owner-specific hint, generic message preserved',
  async (_name, device, hint) => {
    const fact: RuntimeOperationFact = Object.freeze({
      available: false,
      reason: 'unsupported-device-kind',
      hint,
    });
    const facts: RuntimeFacts<PlatformRuntimeOperations> = {
      device: { ...deviceShape(device), providerMode: 'local' },
      operations: { tvRemote: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
    };
    const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
    const bindDevice = vi.fn() as unknown as BindDeviceRuntime;

    const resolved = await resolveBoundTvRemoteRuntime({
      device,
      positionals: ['down'],
      inspectFacts,
      bindDevice,
    });

    expect(resolved).toEqual({
      ok: false,
      response: {
        ok: false,
        error: {
          code: 'UNSUPPORTED_OPERATION',
          message: 'tv-remote is not supported on this device',
          hint,
        },
      },
    });
    expect(bindDevice).not.toHaveBeenCalled();
  },
);

test('request router joins tv-remote admission to execution and ref invalidation', async () => {
  const harness = runtimeHarness();
  const sessionStore = makeSessionStore('agent-device-tv-remote-generic-');
  const session = makeSession('tv-remote-runtime', { device: vegaVvd });
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
    command: 'tv-remote',
    positionals: ['down'],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'tv-remote-router-join' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: { action: 'tv-remote', button: 'down', message: 'Pressed TV remote down' },
  });
  expect(session.refFrameState).toBe('expired');
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.tvRemote).toHaveBeenCalledTimes(1);
});
