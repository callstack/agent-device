import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';

const SHUTDOWN_TIMEOUT_MS = 15_000;

export type AndroidShutdownRuntime = Readonly<{
  canShutdownTarget(device: DeviceInfo): boolean;
  shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
}>;

export function createAndroidShutdownRuntime(
  dependencies: Pick<DeviceShutdownRuntimeDependencies, 'commands'>,
): AndroidShutdownRuntime {
  return Object.freeze({
    canShutdownTarget,
    shutdownTarget: async (device, signal) =>
      await shutdownAndroidTarget(dependencies.commands, device, signal),
  });
}

export function canShutdownTarget(device: DeviceInfo): boolean {
  return device.platform === 'android' && device.kind === 'emulator';
}

async function shutdownAndroidTarget(
  commands: DeviceShutdownRuntimeDependencies['commands'],
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<TargetShutdownResult> {
  if (device.booted === false) return stoppedTargetSuccess();

  signal.throwIfAborted();
  try {
    const result = await commands.run(
      {
        executable: 'adb',
        args: ['-s', device.id, 'emu', 'kill'],
        allowFailure: true,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      },
      signal,
    );
    signal.throwIfAborted();
    const exitCode = result.exitCode ?? -1;
    return {
      success: exitCode === 0,
      exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    signal.throwIfAborted();
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

function stoppedTargetSuccess(): TargetShutdownResult {
  return { success: true, exitCode: 0, stdout: '', stderr: '' };
}
