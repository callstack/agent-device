import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidShell } from './adb.ts';
import type { AndroidAdbExecutorResult } from './adb-executor.ts';

/**
 * The device's `ro.build.version.sdk`; `sdkInt` is `null` when the property cannot be read as an
 * API level, and `result` keeps the `getprop` output for the caller's error.
 */
export async function readAndroidSdkInt(
  device: DeviceInfo,
  signal?: AbortSignal,
): Promise<{ sdkInt: number | null; result: AndroidAdbExecutorResult }> {
  const result = await runAndroidShell(device, ['getprop', 'ro.build.version.sdk'], {
    allowFailure: true,
    signal,
  });
  if (result.exitCode !== 0) return { sdkInt: null, result };
  const value = result.stdout.trim();
  return { sdkInt: /^[1-9]\d{0,3}$/.test(value) ? Number(value) : null, result };
}
