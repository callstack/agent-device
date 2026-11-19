import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readProcessIdentityFacts: vi.fn(),
}));
vi.mock('@agent-device/host-kit/process', () => ({
  readProcessIdentityFacts: mocks.readProcessIdentityFacts,
}));

import { readAndroidEmulatorLaunchStartTime } from './device-boot.ts';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.readProcessIdentityFacts.mockResolvedValue({ startTime: 'start', zombie: false });
});

test('reads the launch start time the process read answers with', async () => {
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBe('start');
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledExactlyOnceWith(4242, 5_000);
});

test('a slow launch start time read is retried once with the full budget', async () => {
  mocks.readProcessIdentityFacts
    .mockRejectedValueOnce(new Error('ps timed out after 5000ms'))
    .mockResolvedValueOnce({ startTime: 'launch', zombie: false });
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBe('launch');
  expect(mocks.readProcessIdentityFacts.mock.calls).toEqual([
    [4242, 5_000],
    [4242, 5_000],
  ]);
});

test('a zombie launch has no start time and is not read again', async () => {
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({ startTime: null, zombie: true });
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBeNull();
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledTimes(1);
});

test('a launch the host never answers for has no start time after both reads', async () => {
  mocks.readProcessIdentityFacts.mockResolvedValue({ startTime: null, zombie: null });
  expect(await readAndroidEmulatorLaunchStartTime(4242)).toBeNull();
  expect(mocks.readProcessIdentityFacts).toHaveBeenCalledTimes(2);
});
