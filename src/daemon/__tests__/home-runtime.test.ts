import { expect, test, vi } from 'vitest';
import { homeRuntimeOperationFacts } from '@agent-device/contracts/home-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  homeRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import { resolveBoundHomeRuntime } from '../home-runtime.ts';
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
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
});

function homeExecutionParams(
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  const session = makeSession('home-runtime', { device: macOsDevice });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'home',
    request: { command: 'home', positionals: [], token: 't', session: session.name },
    positionals: [],
    out: undefined,
    dispatchContext,
  };
}

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const home = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(macOsDevice), providerMode: 'local' },
    operations: { home: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: macOsDevice,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: { home },
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
  return { home, inspectFacts, bindDevice, bind, gateway };
}

test('resolves one admitted binding and drives one home navigation', async () => {
  const harness = runtimeHarness(homeRuntimeOperationFacts({ home: available }).home);

  const resolved = await resolveBoundHomeRuntime({
    device: macOsDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(macOsDevice, homeRuntimeUse);
  expect(await resolved.execute(homeExecutionParams())).toEqual({
    action: 'home',
    message: 'Home',
  });
  expect(harness.home).toHaveBeenCalledTimes(1);
});

test('rejects an unavailable exact-owner fact before binding (macOS has no springboard home)', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundHomeRuntime({
    device: macOsDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: { code: 'UNSUPPORTED_OPERATION', message: 'home is not supported on this device' },
    },
  });
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('request router joins home admission to execution, recording, and ref invalidation', async () => {
  const harness = runtimeHarness();
  const sessionStore = makeSessionStore('agent-device-home-generic-');
  const session = makeSession('home-runtime', { device: macOsDevice });
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
  expect(session.refFrameState).toBe('expired');
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.home).toHaveBeenCalledTimes(1);
});
