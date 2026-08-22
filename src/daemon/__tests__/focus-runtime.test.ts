import { expect, test, vi } from 'vitest';
import { focusRuntimeOperationFacts } from '@agent-device/contracts/focus-runtime';
import {
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import {
  type PlatformRuntimeOperations,
  focusRuntimeUse,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import { readFocusPoint, resolveBoundFocusRuntime } from '../focus-runtime.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

const appleDevice = {
  id: 'ios-simulator',
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
  hint: 'focus is supported on Apple simulators and physical devices.',
});

function focusExecutionParams(
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  const session = makeSession('focus-runtime', { device: appleDevice });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'focus',
    request: { command: 'focus', positionals: ['40', '90'], token: 't', session: session.name },
    positionals: ['40', '90'],
    out: undefined,
    dispatchContext,
  };
}

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const focusPoint = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(appleDevice), providerMode: 'local' },
    operations: { focusPoint: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: appleDevice,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: { focusPoint },
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
  return { focusPoint, inspectFacts, bindDevice, bind, gateway };
}

test('resolves one admitted binding and exposes one point focus', async () => {
  const harness = runtimeHarness(focusRuntimeOperationFacts({ focus: available }).focusPoint);

  const resolved = await resolveBoundFocusRuntime({
    device: appleDevice,
    positionals: ['40', '90'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.inspectFacts).toHaveBeenCalledWith(appleDevice);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(appleDevice, focusRuntimeUse);
  expect(await resolved.execute(focusExecutionParams())).toEqual({
    x: 40,
    y: 90,
    message: 'Focused (40, 90)',
  });
  expect(harness.focusPoint).toHaveBeenCalledTimes(1);
  expect(harness.focusPoint).toHaveBeenCalledWith({
    point: { x: 40, y: 90 },
    execution: {
      requestId: undefined,
      verbose: undefined,
      logPath: undefined,
      traceLogPath: undefined,
      iosXctestrunFile: undefined,
      iosXctestDerivedDataPath: undefined,
      iosXctestEnvDir: undefined,
      runnerLeaseContext: undefined,
    },
  });
});

test('forwards the request context the retired leaf passed through its runner context', async () => {
  const harness = runtimeHarness();

  const resolved = await resolveBoundFocusRuntime({
    device: appleDevice,
    positionals: ['40', '90'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  await resolved.execute(
    focusExecutionParams({
      appBundleId: 'com.example.app',
      requestId: 'focus-context',
      logPath: '/tmp/session.log',
      traceLogPath: '/tmp/trace.log',
      verbose: true,
    }),
  );

  expect(harness.focusPoint).toHaveBeenCalledWith(
    expect.objectContaining({
      point: { x: 40, y: 90 },
      options: { appBundleId: 'com.example.app' },
      execution: expect.objectContaining({
        requestId: 'focus-context',
        logPath: '/tmp/session.log',
        traceLogPath: '/tmp/trace.log',
        verbose: true,
      }),
    }),
  );
});

test('rejects a missing coordinate before inspection or binding', async () => {
  const harness = runtimeHarness();

  await expect(
    resolveBoundFocusRuntime({
      device: appleDevice,
      positionals: ['40'],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: 'focus requires x y' });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('parses coordinates exactly as the retired leaf did', () => {
  expect(readFocusPoint(['12', '34'])).toEqual({ x: 12, y: 34 });
  // The leaf used `Number`, not an integer parse, so a fractional point stayed legal.
  expect(readFocusPoint(['12.5', '34.25'])).toEqual({ x: 12.5, y: 34.25 });
  expect(() => readFocusPoint(['left', '34'])).toThrowError(/focus requires x y/);
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundFocusRuntime({
    device: appleDevice,
    positionals: ['40', '90'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'focus is not supported on this device',
        hint: unavailable.hint,
      },
    },
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('request router joins focus admission to execution, recording, and ref invalidation', async () => {
  const harness = runtimeHarness();
  const sessionStore = makeSessionStore('agent-device-focus-generic-');
  const session = makeSession('focus-runtime', { device: appleDevice });
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
    command: 'focus',
    positionals: ['40', '90'],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'focus-router-join' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: { x: 40, y: 90, message: 'Focused (40, 90)' },
  });
  expect(session.refFrameState).toBe('expired');
  expect(session.actions.at(-1)).toMatchObject({
    command: 'focus',
    positionals: ['40', '90'],
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.focusPoint).toHaveBeenCalledTimes(1);
});
