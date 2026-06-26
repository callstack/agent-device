import { runAndroidAdb } from '../platforms/android/adb.ts';
import { getSimulatorState, shutdownSimulator } from '../platforms/ios/simulator.ts';
import type { TargetShutdownResult } from '../target-shutdown-contract.ts';
import type { DeviceInfo } from '../utils/device.ts';
import { normalizeError } from '../utils/errors.ts';
import { isAndroidEmulator, isIosSimulator } from './device-targets.ts';

export type DeviceTargetShutdownResult = TargetShutdownResult;

export function canShutdownDeviceTarget(device: DeviceInfo): boolean {
  return isIosSimulator(device) || isAndroidEmulator(device);
}

export async function shutdownDeviceTarget(
  device: DeviceInfo,
): Promise<DeviceTargetShutdownResult> {
  if (device.booted === false) {
    return {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  }

  try {
    return isIosSimulator(device)
      ? await shutdownIosSimulator(device)
      : await shutdownAndroidEmulator(device);
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: normalized.message,
      error: normalized,
    };
  }
}

async function shutdownIosSimulator(device: DeviceInfo): Promise<DeviceTargetShutdownResult> {
  const result = await shutdownSimulator(device);
  if (result.success) return result;

  const state = await getFinalSimulatorState(device);
  if (state === 'Shutdown') {
    return {
      ...result,
      success: true,
      exitCode: 0,
    };
  }

  return result;
}

async function getFinalSimulatorState(device: DeviceInfo): Promise<string | null> {
  try {
    return await getSimulatorState(device);
  } catch {
    return null;
  }
}

async function shutdownAndroidEmulator(device: DeviceInfo): Promise<DeviceTargetShutdownResult> {
  const result = await runAndroidAdb(device, ['emu', 'kill'], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}
