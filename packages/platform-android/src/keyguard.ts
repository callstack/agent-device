import type { DeviceInfo } from '@agent-device/kernel/device';

import { runAndroidShell } from './adb.ts';
import { androidAdbResultError } from './adb-failure.ts';
import type { AndroidAdbExecutorResult } from './adb-transport.ts';

/**
 * Whether the keyguard is up, as `dumpsys window` reports it, or `undefined` when the dump carries
 * no `isKeyguardShowing=` line. `fold` reads it to clear a lock screen the cover display raised,
 * and `lock-screen` to verify a lock or unlock.
 */
export async function readAndroidKeyguardShowing(
  device: DeviceInfo,
  signal: AbortSignal | undefined,
): Promise<boolean | undefined> {
  const { stdout } = await runCheckedAndroidShell(device, ['dumpsys', 'window'], signal);
  const state = /isKeyguardShowing=(true|false)/.exec(stdout)?.[1];
  return state === undefined ? undefined : state === 'true';
}

/**
 * An executor may hand back a failed result instead of throwing (the managed scoped transport
 * does), so every read checks the exit code itself before trusting stdout: a failed dump must be
 * an adb failure, never an empty dump read as an unlocked screen or a missing state.
 */
export async function runCheckedAndroidShell(
  device: DeviceInfo,
  words: readonly string[],
  signal: AbortSignal | undefined,
): Promise<AndroidAdbExecutorResult> {
  const result = await runAndroidShell(device, words, { signal, allowFailure: true });
  if (result.exitCode !== 0) {
    throw androidAdbResultError(
      `adb shell ${words.join(' ')} exited with code ${result.exitCode}`,
      result,
      { deviceId: device.id },
    );
  }
  return result;
}
