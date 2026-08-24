import { expect, test, vi } from 'vitest';
import { backRuntimeOperationFacts } from '@agent-device/contracts/back-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  backRuntimeUse,
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
import { resolveBoundBackRuntime } from '../back-runtime.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

// File-scoped id, not the widely shared 'ios-simulator' literal: this owner binding's
// `local-family` kind reaches the real on-disk device-claim admission (`require-owner`
// policy), so a shared id risks a cross-file claim collision under parallel test-file
// execution.
const appleDevice = {
  id: 'back-runtime-ios-simulator',
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
  reason: 'unsupported-device-kind' as const,
  hint: 'back is supported on Apple simulators and physical devices.',
});

function backExecutionParams(
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  const session = makeSession('back-runtime', { device: appleDevice });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'back',
    request: { command: 'back', positionals: [], token: 't', session: session.name },
    positionals: [],
    out: undefined,
    dispatchContext,
  };
}

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const back = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(appleDevice), providerMode: 'local' },
    operations: { back: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: appleDevice,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: { back },
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
  return { back, inspectFacts, bindDevice, bind, gateway };
}

test('resolves one admitted binding and drives one back navigation', async () => {
  const harness = runtimeHarness(backRuntimeOperationFacts({ back: available }).back);

  const resolved = await resolveBoundBackRuntime({
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.inspectFacts).toHaveBeenCalledWith(appleDevice);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(appleDevice, backRuntimeUse);
  expect(await resolved.execute(backExecutionParams())).toEqual({
    action: 'back',
    mode: 'in-app',
    message: 'Back',
  });
  expect(harness.back).toHaveBeenCalledTimes(1);
});

test('forwards the requested back mode from the resolved dispatch context', async () => {
  const harness = runtimeHarness();

  const resolved = await resolveBoundBackRuntime({
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  const result = await resolved.execute(backExecutionParams({ backMode: 'system' }));

  expect(result).toEqual({ action: 'back', mode: 'system', message: 'Back' });
  expect(harness.back).toHaveBeenCalledWith(expect.objectContaining({ mode: 'system' }));
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundBackRuntime({
    device: appleDevice,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'back is not supported on this device',
        hint: unavailable.hint,
      },
    },
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('request router joins back admission to execution, recording, and ref invalidation', async () => {
  const harness = runtimeHarness();
  const sessionStore = makeSessionStore('agent-device-back-generic-');
  const session = makeSession('back-runtime', { device: appleDevice });
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
    command: 'back',
    positionals: [],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'back-router-join' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: { action: 'back', mode: 'in-app', message: 'Back' },
  });
  expect(session.refFrameState).toBe('expired');
  expect(session.actions.at(-1)).toMatchObject({ command: 'back' });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.back).toHaveBeenCalledTimes(1);
});
