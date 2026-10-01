import {
  deviceRotationFromSurfaceIndex,
  type DeviceRotation,
} from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { runAndroidShell } from './adb.ts';

/** `dumpsys display` reports the default display's `Surface.ROTATION_*` index under this key. */
export function parseAndroidDisplayRotationIndex(dumpsysDisplay: string): string | undefined {
  return /mCurrentOrientation=(\d)/.exec(dumpsysDisplay)?.[1];
}

/**
 * Best-effort read of the rotation the display is rendering in. A probe that fails or reports
 * no index yields no rotation rather than failing the operation it accompanies.
 */
export async function probeAndroidDisplayRotation(
  device: DeviceInfo,
  options: { timeoutMs: number },
): Promise<DeviceRotation | undefined> {
  try {
    const result = await runAndroidShell(device, ['dumpsys', 'display'], {
      allowFailure: true,
      timeoutMs: options.timeoutMs,
    });
    if (result.exitCode !== 0) return undefined;
    const index = parseAndroidDisplayRotationIndex(result.stdout);
    return index === undefined ? undefined : deviceRotationFromSurfaceIndex(Number(index));
  } catch {
    return undefined;
  }
}
