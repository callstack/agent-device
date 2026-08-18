import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  viewportRuntimeOperationFacts,
  viewportRuntimeUse,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform';
import { deviceShape } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { contextFromFlags } from '../context.ts';
import { activateCompleteRefFrame } from '../ref-frame.ts';
import { dispatchGenericCommand } from '../request-generic-dispatch.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { resolveBoundViewportRuntime } from '../viewport-runtime.ts';

const webDevice = {
  id: 'web',
  name: 'Web',
  platform: 'web',
  kind: 'device',
  booted: true,
} as const;
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing' as const,
  hint: 'viewport is not supported by the exact runtime owner',
});

function runtimeHarness(fact: RuntimeOperationFact = available) {
  const setViewport = vi.fn(async () => undefined);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(webDevice), providerMode: 'local' },
    operations: {
      setViewport: fact,
    } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: webDevice,
    owner: localRuntimeOwner('web'),
    facts,
    operations: { setViewport },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { setViewport, inspectFacts, bindDevice };
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

test('generic route preserves viewport result, recording, and ref invalidation', async () => {
  const harness = runtimeHarness();
  const viewportRuntime = await resolveBoundViewportRuntime({
    device: webDevice,
    positionals: ['1280', '900'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  if (typeof viewportRuntime !== 'function') throw new Error('expected admitted viewport runtime');
  const sessionStore = makeSessionStore('agent-device-viewport-generic-');
  const session = makeSession('viewport-runtime', { device: webDevice });
  activateCompleteRefFrame(session);
  sessionStore.set(session.name, session);

  const response = await dispatchGenericCommand({
    req: {
      command: 'viewport',
      positionals: ['1280', '900'],
      token: 't',
      session: session.name,
    },
    session,
    sessionName: session.name,
    logPath: '',
    sessionStore,
    contextFromFlags: (flags, appBundleId, traceLogPath) =>
      contextFromFlags('', flags, appBundleId, traceLogPath),
    executePlatformCommand: viewportRuntime,
  });

  expect(response).toEqual({
    ok: true,
    data: { width: 1280, height: 900, message: 'Viewport set: 1280x900' },
  });
  expect(session.refFrameState).toBe('expired');
  expect(session.actions.at(-1)).toMatchObject({
    command: 'viewport',
    positionals: ['1280', '900'],
  });
  expect(harness.inspectFacts).toHaveBeenCalledTimes(1);
  expect(harness.bindDevice).toHaveBeenCalledTimes(1);
  expect(harness.setViewport).toHaveBeenCalledTimes(1);
});
