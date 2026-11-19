import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const mocks = vi.hoisted(() => ({
  runCmd: vi.fn(),
  readProcessIdentityFacts: vi.fn(),
}));
vi.mock('@agent-device/host-kit/command', () => ({ runCmd: mocks.runCmd }));
vi.mock('@agent-device/host-kit/process', () => ({
  readProcessIdentityFacts: mocks.readProcessIdentityFacts,
  hostPlatform: () => 'darwin',
}));

import { observeAndroidEmulatorGeneration } from './device-boot.ts';

const device: DeviceInfo = {
  platform: 'android',
  kind: 'emulator',
  id: 'emulator-5558',
  name: 'Pixel',
};

beforeEach(() => {
  vi.resetAllMocks();
  // `lsof -b -w -t` prints the listening process id once, even for IPv4 and IPv6 sockets.
  mocks.runCmd.mockResolvedValue({ exitCode: 0, stdout: '42\n', stderr: '' });
  mocks.readProcessIdentityFacts.mockResolvedValue({ startTime: 'start', zombie: false });
});

const slowRead = () => Promise.reject(new Error('lsof timed out after 5000ms'));

test('observes only the listener on the admitted console port without blocking kernel calls', async () => {
  expect(await observeAndroidEmulatorGeneration(device)).toEqual({ pid: 42, startTime: 'start' });
  expect(mocks.runCmd).toHaveBeenCalledWith(
    'lsof',
    ['-b', '-w', '-t', '-nP', '-iTCP:5558', '-sTCP:LISTEN'],
    expect.objectContaining({ allowFailure: true, timeoutMs: 5_000 }),
  );
});

test('a slow listener read is retried once and still observes the identity', async () => {
  mocks.runCmd.mockImplementationOnce(slowRead);
  expect(await observeAndroidEmulatorGeneration(device)).toEqual({ pid: 42, startTime: 'start' });
  expect(mocks.runCmd).toHaveBeenCalledTimes(2);
});

test('a slow process identity read is retried once', async () => {
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({ startTime: null, zombie: null });
  expect(await observeAndroidEmulatorGeneration(device)).toEqual({ pid: 42, startTime: 'start' });
  expect(mocks.runCmd).toHaveBeenCalledTimes(2);
});

test('two slow reads remain unknown', async () => {
  mocks.runCmd.mockImplementation(slowRead);
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  expect(mocks.runCmd).toHaveBeenCalledTimes(2);
});

test('no listener answers at once without a retry', async () => {
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  expect(mocks.runCmd).toHaveBeenCalledTimes(1);
  expect(mocks.readProcessIdentityFacts).not.toHaveBeenCalled();
});

test('ambiguous listeners, a malformed pid and a zombie remain unknown without a retry', async () => {
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 0, stdout: '42\n43\n', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 0, stdout: '0\n', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  expect(mocks.readProcessIdentityFacts).not.toHaveBeenCalled();
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({ startTime: 'start', zombie: true });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  expect(mocks.runCmd).toHaveBeenCalledTimes(3);
});

test('physical and malformed targets do not inspect host processes', async () => {
  expect(await observeAndroidEmulatorGeneration({ ...device, kind: 'device' })).toBeUndefined();
  expect(
    await observeAndroidEmulatorGeneration({ ...device, id: 'emulator-5558:other' }),
  ).toBeUndefined();
  expect(mocks.runCmd).not.toHaveBeenCalled();
});
