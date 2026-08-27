import { expect, test, vi } from 'vitest';

// `orientation` carries `androidBlockingDialogGuard: true` (like every other generic-route leaf
// in this migration), so this file's Android device reaching the real request router below hits
// the real `adb`-backed `ensureNoAndroidBlockingDialogReady` check. Stub the owner-level dialog
// probe the same way `request-router-android-modal.test.ts` does, so that check short-circuits to
// "clear" without spawning `adb` — matching the daemon's own real guard seam instead of dodging
// the device platform this test is named for.
//
// The probe is owned by `window-state.ts`, which answers every window question from one dumpsys
// read; a stub aimed at the module it used to live in is a silent no-op, because the spread only
// adds a key nothing imports and the real spawn still runs.
vi.mock('../../platforms/android/window-state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/android/window-state.ts')>();
  return {
    ...actual,
    getAndroidBlockingDialogObservation: vi.fn(async () => ({ status: 'clear' }) as const),
  };
});

import {
  orientationRuntimeOperationFacts,
  type SetOrientationResult,
} from '@agent-device/contracts/orientation-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type DeviceRuntimeGateway,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  orientationRuntimeUse,
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
import {
  readRequestedOrientation,
  resolveBoundOrientationRuntime,
} from '../orientation-runtime.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { androidObservationFixture } from './android-observation-fixture.ts';

// File-scoped id, not a shared literal: this owner binding's `local-family` kind reaches the
// real on-disk device-claim admission (`require-owner` policy), so a shared id risks a
// cross-file claim collision under parallel test-file execution.
const testDevice = {
  id: 'orientation-runtime-device',
  name: 'Pixel',
  platform: 'android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
} as const;
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf' as const,
});

function orientationExecutionParams(
  positionals: string[],
  dispatchContext: GenericPlatformExecutionParams['dispatchContext'] = {},
): GenericPlatformExecutionParams {
  const session = makeSession('orientation-runtime', { device: testDevice });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'orientation',
    request: { command: 'orientation', positionals, token: 't', session: session.name },
    positionals,
    out: undefined,
    dispatchContext,
  };
}

function runtimeHarness(
  fact: RuntimeOperationFact = available,
  setOrientation = vi.fn<() => Promise<SetOrientationResult | void>>(async () => undefined),
) {
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(testDevice), providerMode: 'local' },
    operations: { setOrientation: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device: testDevice,
    owner: localRuntimeOwner('android'),
    facts,
    operations: { setOrientation },
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
  return { setOrientation, inspectFacts, bindDevice, bind, gateway };
}

test('parses the requested rotation exactly as the retired leaf did, including its aliases', () => {
  expect(readRequestedOrientation(['landscape-left'])).toBe('landscape-left');
  expect(readRequestedOrientation(['left'])).toBe('landscape-left');
  expect(() => readRequestedOrientation(['sideways'])).toThrow();
});

test('resolves one admitted binding and reports the owner-observed rotation', async () => {
  const setOrientation = vi.fn(async () => ({ orientation: 'landscape-left' as const }));
  const harness = runtimeHarness(
    orientationRuntimeOperationFacts({ orientation: available }).setOrientation,
    setOrientation,
  );

  const resolved = await resolveBoundOrientationRuntime({
    device: testDevice,
    positionals: ['landscape-left'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.bindDevice).toHaveBeenCalledWith(testDevice, orientationRuntimeUse);
  expect(await resolved.execute(orientationExecutionParams(['landscape-left']))).toEqual({
    action: 'orientation',
    orientation: 'landscape-left',
    message: 'Rotated to landscape-left',
  });
});

test('falls back to the requested rotation when the owner reports nothing', async () => {
  const harness = runtimeHarness();

  const resolved = await resolveBoundOrientationRuntime({
    device: testDevice,
    positionals: ['portrait'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute(orientationExecutionParams(['portrait']))).toEqual({
    action: 'orientation',
    orientation: 'portrait',
    message: 'Rotated to portrait',
  });
});

test('rejects an invalid rotation before inspection or binding', async () => {
  const harness = runtimeHarness();

  await expect(
    resolveBoundOrientationRuntime({
      device: testDevice,
      positionals: ['sideways'],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toThrow();
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  const harness = runtimeHarness(unavailable);

  const resolved = await resolveBoundOrientationRuntime({
    device: testDevice,
    positionals: ['landscape-left'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved).toEqual({
    ok: false,
    response: {
      ok: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'orientation is not supported on this device',
      },
    },
  });
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('request router joins orientation admission to execution and ref invalidation', async () => {
  const setOrientation = vi.fn(async () => ({ orientation: 'landscape-left' as const }));
  const harness = runtimeHarness(
    orientationRuntimeOperationFacts({ orientation: available }).setOrientation,
    setOrientation,
  );
  const sessionStore = makeSessionStore('agent-device-orientation-generic-');
  const session = makeSession('orientation-runtime', { device: testDevice });
  activateCompleteRefFrame(session);
  sessionStore.set(session.name, session);
  const handler = createRequestHandler({
    logPath: '/tmp/daemon.log',
    token: 't',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    deviceRuntimeGateway: harness.gateway,
    androidObservation: androidObservationFixture,
    trackDownloadableArtifact: () => 'artifact',
  });

  const response = await handler({
    command: 'orientation',
    positionals: ['landscape-left'],
    token: 't',
    session: session.name,
    flags: {},
    meta: { requestId: 'orientation-router-join' },
  });

  expect(response).toMatchObject({
    ok: true,
    data: {
      action: 'orientation',
      orientation: 'landscape-left',
      message: 'Rotated to landscape-left',
    },
  });
  expect(session.refFrameState).toBe('expired');
  expect(harness.bind).toHaveBeenCalledTimes(1);
  expect(setOrientation).toHaveBeenCalledTimes(1);
});
