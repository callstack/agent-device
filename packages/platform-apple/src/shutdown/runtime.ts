import type { DeviceShutdownRuntimeDependencies } from '@agent-device/contracts/device-shutdown-runtime';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import { getSimulatorState, simctlArgs } from '../simulator-state.ts';

const SHUTDOWN_TIMEOUT_MS = 15_000;

export type AppleShutdownRuntime = Readonly<{
  canShutdownTarget(device: DeviceInfo): boolean;
  shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
}>;

export function createAppleShutdownRuntime(
  dependencies: Pick<DeviceShutdownRuntimeDependencies, 'appleTools'>,
): AppleShutdownRuntime {
  return Object.freeze({
    canShutdownTarget,
    shutdownTarget: async (device, signal) =>
      await shutdownAppleTarget(dependencies.appleTools, device, signal),
  });
}

export function canShutdownTarget(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.appleOs !== 'watchos' && device.kind === 'simulator';
}

async function shutdownAppleTarget(
  appleTools: DeviceShutdownRuntimeDependencies['appleTools'],
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<TargetShutdownResult> {
  if (device.booted === false) return stoppedTargetSuccess();

  signal.throwIfAborted();
  try {
    const result = await appleTools.run(
      {
        tool: 'simctl',
        args: simctlArgs(device, ['shutdown', device.id]),
        allowFailure: true,
        timeoutMs: SHUTDOWN_TIMEOUT_MS,
      },
      signal,
    );
    signal.throwIfAborted();
    const shutdown = toShutdownResult(result);
    if (shutdown.success) return shutdown;

    if ((await finalSimulatorState(appleTools, device, signal)) === 'Shutdown') {
      return { ...shutdown, success: true, exitCode: 0 };
    }
    return shutdown;
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

async function finalSimulatorState(
  appleTools: DeviceShutdownRuntimeDependencies['appleTools'],
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    return await getSimulatorState(appleTools, device, signal, SHUTDOWN_TIMEOUT_MS);
  } catch {
    signal.throwIfAborted();
    return null;
  }
}

function toShutdownResult(result: {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}): TargetShutdownResult {
  const exitCode = result.exitCode ?? -1;
  return {
    success: exitCode === 0,
    exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function stoppedTargetSuccess(): TargetShutdownResult {
  return { success: true, exitCode: 0, stdout: '', stderr: '' };
}
