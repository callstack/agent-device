import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./pose.ts', () => ({ setAppleFoldPose: vi.fn() }));

import type { DeviceInfo } from '@agent-device/kernel/device';

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

beforeEach(() => {
  mockPose.mockReset();
});

test('the default-set iPhone Duo admits setFoldPose and binds the pose operation', () => {
  expect(appleFoldableFacts(duo).setFoldPose).toEqual({ available: true });
  expect(
    createAppleFoldableOperations({ device: duo, signal: new AbortController().signal }),
  ).toHaveProperty('setFoldPose', expect.any(Function));
});

test('a scoped simulator set admits setFoldPose and binds the pose operation to that device', async () => {
  expect(appleFoldableFacts(scopedDuo).setFoldPose).toEqual({ available: true });
  const operations = createAppleFoldableOperations({
    device: scopedDuo,
    signal: new AbortController().signal,
  });
  mockPose.mockResolvedValueOnce({ pose: 'closed', hingeAngleDegrees: 0 });
  await expect(operations.setFoldPose!({ pose: 'closed' })).resolves.toEqual({
    pose: 'closed',
    hingeAngleDegrees: 0,
  });
  expect(mockPose).toHaveBeenCalledWith(scopedDuo, { pose: 'closed' }, expect.anything());
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
