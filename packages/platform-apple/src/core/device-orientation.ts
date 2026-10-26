import type { DeviceRotation } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isCommandTimeoutError } from '@agent-device/host-kit/command';

import { runIosDevicectlJsonRequest, type IosDevicectlJsonOutcome } from './devicectl.ts';

/** CoreDevice `deviceOrientation` names, which are UIDeviceOrientation case names. */
const CORE_DEVICE_ORIENTATIONS: ReadonlyMap<unknown, DeviceRotation> = new Map<
  unknown,
  DeviceRotation
>([
  ['portrait', 'portrait'],
  ['portraitUpsideDown', 'portrait-upside-down'],
  ['landscapeLeft', 'landscape-left'],
  ['landscapeRight', 'landscape-right'],
]);

/**
 * Reads the orientation of the device itself through `devicectl device orientation get`.
 * The display table's `currentDeviceOrientation` is not a replacement: on the iPhone Duo inner
 * panel, it is a quarter-turn from the device orientation.
 *
 * CoreDevice answers each query with the orientation it sampled at the previous query, so the
 * first read after a change can be stale. A failed or timed-out read, face-up, and face-down
 * return nothing.
 */
export async function readAppleDeviceOrientation(
  device: DeviceInfo,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<DeviceRotation | undefined> {
  let outcome: IosDevicectlJsonOutcome;
  try {
    outcome = await runIosDevicectlJsonRequest({
      jsonPrefix: 'agent-device-apple-orientation',
      args: ['devicectl', 'device', 'orientation', 'get', '--device', device.id],
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || !isCommandTimeoutError(error)) throw error;
    return undefined;
  }
  if (!outcome.ok) return undefined;
  const payload = outcome.payload as { result?: { deviceOrientation?: unknown } } | null;
  return CORE_DEVICE_ORIENTATIONS.get(payload?.result?.deviceOrientation);
}
