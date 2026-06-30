import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '../../kernel/device.ts';

vi.mock('../../platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../platforms/apple/core/simulator.ts')>();
  return {
    ...actual,
    getSimulatorState: vi.fn(),
    shutdownSimulator: vi.fn(),
  };
});

vi.mock('../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

import { shutdownDeviceTarget } from '../target-shutdown.ts';
import { getSimulatorState, shutdownSimulator } from '../../platforms/apple/core/simulator.ts';
import { runCmd } from '../../utils/exec.ts';

const mockGetSimulatorState = vi.mocked(getSimulatorState);
const mockShutdownSimulator = vi.mocked(shutdownSimulator);
const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSimulatorState.mockResolvedValue(null);
  mockShutdownSimulator.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' });
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

test('shutdownDeviceTarget treats already-stopped targets as success', async () => {
  const device: DeviceInfo = {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: false,
  };

  await expect(shutdownDeviceTarget(device)).resolves.toEqual({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  expect(mockShutdownSimulator).not.toHaveBeenCalled();
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('shutdownDeviceTarget treats iOS Shutdown final state as success', async () => {
  const device: DeviceInfo = {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  };
  mockShutdownSimulator.mockResolvedValue({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'Unable to shutdown device in current state: Shutdown',
  });
  mockGetSimulatorState.mockResolvedValue('Shutdown');

  await expect(shutdownDeviceTarget(device)).resolves.toEqual({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: 'Unable to shutdown device in current state: Shutdown',
  });
  expect(mockGetSimulatorState).toHaveBeenCalledWith(device);
});

test('shutdownDeviceTarget preserves iOS shutdown failure when final state probe fails', async () => {
  const device: DeviceInfo = {
    platform: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  };
  mockShutdownSimulator.mockResolvedValue({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'simctl shutdown failed',
  });
  mockGetSimulatorState.mockRejectedValue(new Error('simctl list failed'));

  await expect(shutdownDeviceTarget(device)).resolves.toEqual({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'simctl shutdown failed',
  });
});
