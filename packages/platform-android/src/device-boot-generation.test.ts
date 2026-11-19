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
  // The real macOS shape for an emulator listening on IPv4 and IPv6: one process, two sockets.
  mocks.runCmd.mockResolvedValue({ exitCode: 0, stdout: 'p42\nf31\nf32\n', stderr: '' });
  mocks.readProcessIdentityFacts.mockResolvedValue({ startTime: 'start', zombie: false });
});

test('observes only the listener on the admitted console port', async () => {
  expect(await observeAndroidEmulatorGeneration(device)).toEqual({ pid: 42, startTime: 'start' });
  expect(mocks.runCmd).toHaveBeenCalledWith(
    'lsof',
    ['-nP', '-iTCP:5558', '-sTCP:LISTEN', '-Fp'],
    expect.anything(),
  );
});

test('ambiguous listeners and missing process identity remain unknown', async () => {
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 0, stdout: 'p42\nf31\np43\nf32\n', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  expect(mocks.readProcessIdentityFacts).not.toHaveBeenCalled();
  mocks.readProcessIdentityFacts.mockResolvedValueOnce({ startTime: null, zombie: false });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
});

test('one process with a single listening socket is observed', async () => {
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 0, stdout: 'p42\nf31\n', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toEqual({ pid: 42, startTime: 'start' });
});

test('no listener or a malformed pid remains unknown', async () => {
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  mocks.runCmd.mockResolvedValueOnce({ exitCode: 0, stdout: 'p0\nf31\n', stderr: '' });
  expect(await observeAndroidEmulatorGeneration(device)).toBeUndefined();
  expect(mocks.readProcessIdentityFacts).not.toHaveBeenCalled();
});

test('physical and malformed targets do not inspect host processes', async () => {
  expect(await observeAndroidEmulatorGeneration({ ...device, kind: 'device' })).toBeUndefined();
  expect(
    await observeAndroidEmulatorGeneration({ ...device, id: 'emulator-5558:other' }),
  ).toBeUndefined();
  expect(mocks.runCmd).not.toHaveBeenCalled();
});
