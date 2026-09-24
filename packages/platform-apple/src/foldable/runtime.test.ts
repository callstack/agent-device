import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./pose.ts', () => ({ setAppleFoldPose: vi.fn() }));

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

import { appleFoldableFacts, createAppleFoldableOperations } from './runtime.ts';
import { setAppleFoldPose } from './pose.ts';

const mockPose = vi.mocked(setAppleFoldPose);

const duo: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: '4F879835-4AB3-4046-B033-5AB769209DD4',
  name: 'iPhone Duo',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
};
const scopedDuo: DeviceInfo = { ...duo, simulatorSetPath: '/tmp/scoped-set' };

/** A full owner binding whose fold cell is derived only from the fact under test. */
function foldBinding(device: DeviceInfo): DeviceBinding<PlatformRuntimeOperations> {
  const { setFoldPose } = appleFoldableFacts(device);
  return {
    device,
    owner: localRuntimeOwner('apple'),
    facts: {
      device: { ...deviceShape(device), providerMode: 'local' },
      operations: { setFoldPose } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
    },
    operations: createAppleFoldableOperations({ device, signal: new AbortController().signal }),
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

test('the default-set iPhone Duo admits setFoldPose and binds the pose operation', () => {
  expect(appleFoldableFacts(duo).setFoldPose).toEqual({ available: true });
  expect(
    createAppleFoldableOperations({ device: duo, signal: new AbortController().signal }),
  ).toHaveProperty('setFoldPose', expect.any(Function));
});

test('a scoped simulator set refuses setFoldPose with the typed unsupported-device-scope fact', () => {
  expect(appleFoldableFacts(scopedDuo).setFoldPose).toMatchObject({
    available: false,
    reason: 'unsupported-device-scope',
    hint: expect.stringContaining('/tmp/scoped-set'),
  });
});

test('a scoped simulator set binds no pose operation and never reaches a hinge', () => {
  const operations = createAppleFoldableOperations({
    device: scopedDuo,
    signal: new AbortController().signal,
  });
  expect(operations).not.toHaveProperty('setFoldPose');
  expect(mockPose).not.toHaveBeenCalled();
});

test('the routed fold response refuses a scoped simulator set with the typed reason before any tool call', () => {
  const refusal = thrownBy(() => narrowDeviceBinding(foldBinding(scopedDuo), foldRuntimeUse)) as {
    code?: string;
    details?: { reason?: string; hint?: string };
  };
  expect(refusal.code).toBe('UNSUPPORTED_OPERATION');
  expect(refusal.details?.reason).toBe('unsupported-device-scope');
  expect(refusal.details?.hint).toContain('/tmp/scoped-set');
  expect(mockPose).not.toHaveBeenCalled();
});

test('a scoped set never outranks the existing kind and OS refusals', () => {
  expect(appleFoldableFacts({ ...scopedDuo, kind: 'device' }).setFoldPose).toMatchObject({
    available: false,
    reason: 'unsupported-device-kind',
  });
  expect(
    appleFoldableFacts({ ...scopedDuo, appleOs: 'tvos', target: 'tv' }).setFoldPose,
  ).toMatchObject({ available: false, reason: 'unsupported-platform-leaf' });
});
