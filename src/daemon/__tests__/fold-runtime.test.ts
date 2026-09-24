import { recordActionEntry } from '../session-action-recorder.ts';
import { expect, test, vi } from 'vitest';

import {
  foldRuntimeOperationFacts,
  type SetFoldPoseResult,
} from '@agent-device/contracts/fold-runtime';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
  type RuntimeOperationFact,
} from '@agent-device/contracts/platform-runtime';
import {
  foldRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { GenericPlatformExecutionParams } from '../request-generic-dispatch.ts';
import { readRequestedFoldPose, resolveBoundFoldRuntime } from '../fold-runtime.ts';
import { expectRefusesUnavailableExactOwnerFact } from './runtime-binding-conformance.ts';

// File-scoped id: this owner binding's `local-family` kind reaches the real on-disk device-claim
// admission, so a shared id risks a cross-file claim collision under parallel execution.
const testDevice = {
  id: 'fold-runtime-device',
  name: 'iPhone Duo',
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

function foldExecutionParams(positionals: string[]): GenericPlatformExecutionParams {
  const session = makeSession('fold-runtime', { device: testDevice });
  return {
    session,
    sessionName: session.name,
    logPath: '/tmp/daemon.log',
    command: 'fold',
    request: { command: 'fold', positionals, token: 't', session: session.name },
    positionals,
    out: undefined,
    dispatchContext: {},
  };
}

function runtimeHarness(
  fact: RuntimeOperationFact = available,
  setFoldPose = vi.fn<() => Promise<SetFoldPoseResult>>(async () => ({
    pose: 'open',
    hingeAngleDegrees: 180,
  })),
  device: DeviceInfo = testDevice,
) {
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: { setFoldPose: fact } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
  };
  const binding = {
    device,
    owner: localRuntimeOwner('apple'),
    facts,
    operations: { setFoldPose },
    [Symbol.asyncDispose]: async () => {},
  } satisfies DeviceBinding<PlatformRuntimeOperations>;
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => facts);
  const bindDevice = vi.fn(async (_device, use) =>
    narrowDeviceBinding(binding, use),
  ) as unknown as BindDeviceRuntime;
  return { setFoldPose, inspectFacts, bindDevice };
}

test('parses the requested pose with the CLI aliases', () => {
  expect(readRequestedFoldPose(['open'])).toBe('open');
  expect(readRequestedFoldPose(['book'])).toBe('half-open');
  expect(() => readRequestedFoldPose(['sideways'])).toThrow();
});

test('resolves one admitted binding and reports the pose the owner read back', async () => {
  const setFoldPose = vi.fn(async () => ({
    pose: 'open' as const,
    hingeAngleDegrees: 180,
    screen: {
      display: 'LCD-1',
      coordinateSpace: 'native-panel' as const,
      widthPt: 669,
      heightPt: 951,
    },
  }));
  const harness = runtimeHarness(
    foldRuntimeOperationFacts({ fold: available }).setFoldPose,
    setFoldPose,
  );

  const resolved = await resolveBoundFoldRuntime({
    device: testDevice,
    positionals: ['unfolded'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(harness.bindDevice).toHaveBeenCalledWith(testDevice, foldRuntimeUse);
  expect(await resolved.execute(foldExecutionParams(['unfolded']))).toEqual({
    action: 'fold',
    pose: 'open',
    hingeAngleDegrees: 180,
    screen: { display: 'LCD-1', coordinateSpace: 'native-panel', widthPt: 669, heightPt: 951 },
    message:
      'Folded to open (hinge 180°, LCD-1 native panel 669x951pt, not snapshot coordinates); refs from before the pose change are stale',
  });
  expect(setFoldPose).toHaveBeenCalledWith({ pose: 'open' });
});

test('reports a pose without a panel reading when the owner could not name the lit panel', async () => {
  const harness = runtimeHarness();
  const resolved = await resolveBoundFoldRuntime({
    device: testDevice,
    positionals: ['open'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute(foldExecutionParams(['open']))).toEqual({
    action: 'fold',
    pose: 'open',
    hingeAngleDegrees: 180,
    message: 'Folded to open (hinge 180°); refs from before the pose change are stale',
  });
});

test('rejects an invalid pose before inspection or binding', async () => {
  const harness = runtimeHarness();
  await expect(
    resolveBoundFoldRuntime({
      device: testDevice,
      positionals: ['sideways'],
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_ARGS', message: expect.stringContaining('sideways') });
  expect(harness.inspectFacts).not.toHaveBeenCalled();
  expect(harness.bindDevice).not.toHaveBeenCalled();
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  await expectRefusesUnavailableExactOwnerFact({
    command: 'fold',
    device: testDevice,
    unavailable,
    // The fold route derives its refusal from the fact, so the wire error keeps the typed reason.
    refusal: {
      code: 'UNSUPPORTED_OPERATION',
      message: 'fold is not supported on this device',
      details: { reason: 'unsupported-platform-leaf' },
    },
  });
});

// The scoped-set refusal is a real route outcome, not just a narrowed binding: a scoped session's
// `setFoldPose` fact refuses on admission, so the wire error carries the typed reason and the set
// name, and the device is never bound or posed.
test('refuses a scoped simulator set on the route with the typed reason, never binding', async () => {
  const scopedDevice: DeviceInfo = { ...testDevice, simulatorSetPath: '/tmp/scoped-set' };
  const scopeRefusal = {
    available: false,
    reason: 'unsupported-device-scope',
    hint: 'fold cannot resolve a simulator scoped to the set at "/tmp/scoped-set".',
  } as const;
  const harness = runtimeHarness(scopeRefusal, vi.fn(), scopedDevice);

  const resolved = await resolveBoundFoldRuntime({
    device: scopedDevice,
    positionals: ['half-open'],
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(resolved.ok).toBe(false);
  if (resolved.ok || resolved.response.ok) throw new Error('the scoped-set fact admitted fold');
  expect(resolved.response.error).toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    message: 'fold is not supported on this device',
    hint: expect.stringContaining('/tmp/scoped-set'),
    details: { reason: 'unsupported-device-scope' },
  });
  expect(harness.bindDevice).not.toHaveBeenCalled();
  expect(harness.setFoldPose).not.toHaveBeenCalled();
});

test('passes the validated timed intent to the admitted fold owner', async () => {
  const setFoldPose = vi.fn(async (): Promise<SetFoldPoseResult> => ({
    pose: 'half-open',
    hingeAngleDegrees: 100,
  }));
  const harness = runtimeHarness(available, setFoldPose);
  const keyframes = [
    { atMs: 0, angle: 0 },
    { atMs: 5000, angle: 100 },
  ];
  const resolved = await resolveBoundFoldRuntime({
    device: testDevice,
    positionals: [],
    keyframes: JSON.stringify(keyframes),
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });
  expect(resolved.ok).toBe(true);
  if (!resolved.ok) return;
  expect(await resolved.execute(foldExecutionParams([]))).toMatchObject({ hingeAngleDegrees: 100 });
  expect(setFoldPose).toHaveBeenCalledWith({ keyframes });
});

test('recording preserves the timeline for replay', () => {
  const keyframes = JSON.stringify([
    { atMs: 0, angle: 0 },
    { atMs: 5000, angle: 180 },
  ]);
  const action = recordActionEntry(makeSession('fold-recording'), {
    command: 'fold',
    positionals: [],
    flags: { keyframes },
    result: { pose: 'open', hingeAngleDegrees: 180 },
  });
  expect(action?.flags?.keyframes).toBe(keyframes);
});
