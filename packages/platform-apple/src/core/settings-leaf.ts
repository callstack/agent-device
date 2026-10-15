import type { AppleSettingLeafRefusal } from '@agent-device/contracts/settings';
import {
  isHandheldAppleSimulator,
  resolveDeviceAppleOs,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/**
 * The leaf rule every Apple setting that was only ever verified on an iPhone/iPad simulator enforces
 * on its own when it is reached directly: `settings` admission is one cell covering the whole
 * simulator family, so an owner whose surface is narrower has to refuse the rest itself rather than
 * report a change on a device whose setting may not exist. The predicate is the same
 * `isHandheldAppleSimulator` the runtime's read fact reads; only the prose differs, and the caller
 * passes the refusal its setting declares in `@agent-device/contracts/settings`.
 */
export function requireHandheldAppleSimulatorLeaf(
  device: DeviceInfo,
  refusal: AppleSettingLeafRefusal,
): void {
  if (isHandheldAppleSimulator(device)) return;
  throw new AppError('UNSUPPORTED_OPERATION', refusal.message, {
    deviceId: device.id,
    appleOs: resolveDeviceAppleOs(device),
    deviceKind: device.kind,
    reason: refusal.reason,
    hint: refusal.hint,
  });
}
