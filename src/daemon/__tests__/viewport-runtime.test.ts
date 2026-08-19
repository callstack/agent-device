import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  viewportRuntimeOperationFacts,
  viewportRuntimeUse,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform';
import { deviceShape } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { resolveBoundViewportRuntime } from '../viewport-runtime.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

const webDevice = {
  id: 'web',
  name: 'Web',
  platform: 'web',
  kind: 'device',
  booted: true,
} as const;
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
  reason: 'owner-capability-missing' as const,
  hint: 'viewport is not supported by the exact runtime owner',
});

function runtimeHarness(
  fact: RuntimeOperationFact = available,
  device: typeof webDevice | typeof appleDevice = webDevice,
) {
  const setViewport = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      setViewport: fact,
    } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device,
    owner: localRuntimeOwner(device.platform),
    facts,
    operations: { setViewport },
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
  return { setViewport, inspectFacts, bindDevice, bind, gateway };
}

test('resolves one admitted binding and exposes one normalized viewport operation', async () => {
  const harness = runtimeHarness(
    viewportRuntimeOperationFacts({ setViewport: available }).setViewport,
  );

  const resolved = await resolveBoundViewportRuntime({
    device: webDevice,
    positionals: ['1280', '900'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toBeTypeOf('function');
  if (typeof resolved !== 'function') return;
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.inspectFacts).toHaveBeenCalledWith(webDevice);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledWith(webDevice, viewportRuntimeUse);
  expect(await resolved()).toEqual({
    width: 1280,
    height: 900,
    message: 'Viewport set: 1280x900',
  });
  expect(harness.setViewport).toHaveBeenCalledTimes(1);
  expect(harness.setViewport).toHaveBeenCalledWith({ width: 1280, height: 900 });
});

test('rejects invalid dimensions before inspection or binding', async () => {
  const harness = runtimeHarness();

  await expect(
    resolveBoundViewportRuntime({
      device: webDevice,
      positionals: ['0', '900'],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundViewportRuntime({
    device: webDevice,
    positionals: ['1280', '900'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'viewport is not supported on this device',
      hint: unavailable.hint,
    },
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('preserves the Apple viewport recovery hint through admission', async () => {
  const hint =
    'viewport resizes web targets only (--platform web). Apple screen geometry is fixed by the selected simulator or device type — open a different simulator to test another screen size.';
  const harness = runtimeHarness(
    { available: false, reason: 'unsupported-platform-leaf', hint },
    appleDevice,
  );

  const resolved = await resolveBoundViewportRuntime({
    device: appleDevice,
    positionals: ['1280', '900'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'viewport is not supported on this device',
      hint,
    },
  });
  expect(harness.inspectFacts).toHaveBeenCalledOnce();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('request router joins viewport admission to execution, recording, and ref invalidation', async () => {
  const harness = runtimeHarness();
  const sessionStore = makeSessionStore('agent-device-viewport-generic-');
  const session = makeSession('viewport-runtime', { device: webDevice });
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
    command: 'viewport',
    positionals: ['1280', '900'],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'viewport-router-join' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: { width: 1280, height: 900, message: 'Viewport set: 1280x900' },
  });
  expect(session.refFrameState).toBe('expired');
  expect(session.actions.at(-1)).toMatchObject({
    command: 'viewport',
    positionals: ['1280', '900'],
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(harness.setViewport).toHaveBeenCalledTimes(1);
});
