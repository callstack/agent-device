import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isAndroidShellCommandUnsupported, runAndroidAdb } from './adb.ts';
import { androidAdbResultError, type AndroidAdbExecutorResult } from './adb-executor.ts';

export type AndroidAirplaneMode = 'enabled' | 'disabled';

const AIRPLANE_MODE_ARGS = ['shell', 'cmd', 'connectivity', 'airplane-mode'] as const;

/**
 * Android's connectivity service owns airplane mode: it reports the state and it drives the radios
 * behind it. Writing `airplane_mode_on` and broadcasting `ACTION_AIRPLANE_MODE_CHANGED` instead
 * moves the setting while connectivity stays up, and the broadcast is refused for non-system
 * callers (#2223).
 *
 * Support is proven before the write and the state is read after it, so a build that cannot answer
 * for airplane mode is refused unmutated and the reported mode is the one connectivity holds rather
 * than the one that was asked for.
 */
export async function setAndroidAirplaneMode(
  device: DeviceInfo,
  enabled: boolean,
): Promise<{ airplaneMode: AndroidAirplaneMode }> {
  const requested: AndroidAirplaneMode = enabled ? 'enabled' : 'disabled';
  await requireAndroidAirplaneModeSupport(device);
  await runAndroidAdb(device, [...AIRPLANE_MODE_ARGS, enabled ? 'enable' : 'disable']);
  const airplaneMode = await readAndroidAirplaneMode(device);
  if (airplaneMode !== requested) {
    throw new AppError(
      'COMMAND_FAILED',
      `Android airplane mode reads ${airplaneMode} after requesting ${requested}.`,
      { deviceId: device.id, requested, airplaneMode },
    );
  }
  return { airplaneMode };
}

async function requireAndroidAirplaneModeSupport(device: DeviceInfo): Promise<void> {
  const { state, result } = await probeAndroidAirplaneMode(device);
  if (state) return;
  if (result.exitCode !== 0 && isAndroidShellCommandUnsupported(result.stdout, result.stderr)) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'The connectivity service on this Android build has no airplane-mode command, so nothing was changed.',
      {
        deviceId: device.id,
        hint: 'settings airplane needs cmd connectivity airplane-mode, which requires Android 11 (API 30) or newer. Use a newer device or emulator image.',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
    );
  }
  throw androidAdbResultError('Failed to read Android airplane mode', result, {
    deviceId: device.id,
  });
}

async function readAndroidAirplaneMode(device: DeviceInfo): Promise<AndroidAirplaneMode> {
  const { state, result } = await probeAndroidAirplaneMode(device);
  if (state) return state;
  throw androidAdbResultError('Failed to read Android airplane mode after changing it', result, {
    deviceId: device.id,
  });
}

async function probeAndroidAirplaneMode(device: DeviceInfo): Promise<{
  state: AndroidAirplaneMode | undefined;
  result: AndroidAdbExecutorResult;
}> {
  const result = await runAndroidAdb(device, [...AIRPLANE_MODE_ARGS], { allowFailure: true });
  return {
    state: result.exitCode === 0 ? parseAndroidAirplaneMode(result.stdout) : undefined,
    result,
  };
}

function parseAndroidAirplaneMode(stdout: string): AndroidAirplaneMode | undefined {
  const value = stdout.trim().toLowerCase();
  if (value === 'enabled') return 'enabled';
  if (value === 'disabled') return 'disabled';
  return undefined;
}
