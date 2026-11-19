import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { awaitTestImeFlushWindow } from '../ime-state.ts';

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
  // Every kill of an emulator goes through here, so this is where the settings-provider flush
  // window is enforced for ALL kill paths — close --shutdown, the standalone shutdown command,
  // and any future caller. A restore this process registered postpones the kill until the
  // provider has rewritten its file; an abort cancels the kill rather than letting it land
  // inside the window, and the timestamp stays for the retry to wait out the remainder.
  await awaitTestImeFlushWindow(device.id, signal);
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
