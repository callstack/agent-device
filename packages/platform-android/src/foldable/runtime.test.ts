import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./pose.ts', () => ({ setAndroidFoldPose: vi.fn() }));

import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import {
  foldRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';

import { ANDROID_EMULATOR, UNKNOWN_KIND_DEVICE } from '../runtime.fixtures.ts';
import { androidFoldableFacts, createAndroidFoldableOperations } from './runtime.ts';
import { setAndroidFoldPose } from './pose.ts';

const mockPose = vi.mocked(setAndroidFoldPose);

const physical: DeviceInfo = { ...ANDROID_EMULATOR, kind: 'device' };

/** A full owner binding whose fold cell is derived only from the fact under test. */
function foldBinding(device: DeviceInfo): DeviceBinding<PlatformRuntimeOperations> {
  const { setFoldPose } = androidFoldableFacts(device);
  return {
    device,
    owner: localRuntimeOwner('android'),
    facts: {
      device: { ...deviceShape(device), providerMode: 'local' },
      operations: { setFoldPose } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
    },
    operations: createAndroidFoldableOperations({ device, signal: new AbortController().signal }),
    [Symbol.asyncDispose]: async () => {},
  };
}

function thrownBy<T>(run: () => T): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the routed fold binding to refuse');
}

beforeEach(() => {
  mockPose.mockReset();
});

test('an emulator admits setFoldPose and binds the pose operation', async () => {
  expect(androidFoldableFacts(ANDROID_EMULATOR).setFoldPose).toEqual({ available: true });
  const operations = createAndroidFoldableOperations({
    device: ANDROID_EMULATOR,
    signal: new AbortController().signal,
  });
  expect(operations).toHaveProperty('setFoldPose', expect.any(Function));

  mockPose.mockResolvedValueOnce({ pose: 'closed', hingeAngleDegrees: 0 });
  await expect(operations.setFoldPose?.({ pose: 'closed' })).resolves.toEqual({
    pose: 'closed',
    hingeAngleDegrees: 0,
  });
  expect(mockPose).toHaveBeenCalledWith(
    ANDROID_EMULATOR,
    { pose: 'closed' },
    { signal: expect.any(AbortSignal) },
  );
});

test('a physical device and an unknown kind refuse setFoldPose with the typed kind fact', () => {
  for (const device of [physical, UNKNOWN_KIND_DEVICE]) {
    expect(androidFoldableFacts(device).setFoldPose).toMatchObject({
      available: false,
      reason: 'unsupported-device-kind',
      hint: expect.stringContaining('folded by hand'),
    });
    const operations = createAndroidFoldableOperations({
      device,
      signal: new AbortController().signal,
    });
    expect(operations).not.toHaveProperty('setFoldPose');
  }
  expect(mockPose).not.toHaveBeenCalled();
});

test('the narrowed fold use refuses a physical device with the typed fact reason and hint', () => {
  const refusal = thrownBy(() => narrowDeviceBinding(foldBinding(physical), foldRuntimeUse)) as {
    code?: string;
    details?: { reason?: string; hint?: string };
  };
  expect(refusal.code).toBe('UNSUPPORTED_OPERATION');
  expect(refusal.details?.reason).toBe('unsupported-device-kind');
  expect(refusal.details?.hint).toContain('folded by hand');
});

test('an aborted scope never reaches the emulator console', async () => {
  const controller = new AbortController();
  const operations = createAndroidFoldableOperations({
    device: ANDROID_EMULATOR,
    signal: controller.signal,
  });
  controller.abort();
  await expect(operations.setFoldPose?.({ pose: 'open' })).rejects.toThrow();
  expect(mockPose).not.toHaveBeenCalled();
});
