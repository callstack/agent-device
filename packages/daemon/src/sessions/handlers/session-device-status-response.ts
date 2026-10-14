import type { TargetShutdownResult } from '@agent-device/contracts/device';
import {
  isApplePlatform,
  publicPlatformString,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import type { DaemonResponse } from '../../core/daemon-request.ts';

/** The per-command status field a device-status report carries beside the device identity. */
export type DeviceStatusReport = Readonly<{ booted: true } | { shutdown: TargetShutdownResult }>;

/**
 * Answers "what does this device report about itself on the wire after a readiness
 * command?": the public device identity fields, the command's own status field, and the
 * additive Apple-OS discriminant. `boot` and `shutdown` share this shape and differ only
 * in the status field.
 */
export function deviceStatusReportResponse(
  device: DeviceInfo,
  status: DeviceStatusReport,
): DaemonResponse {
  return {
    ok: true,
    data: {
      platform: publicPlatformString(device),
      target: device.target ?? 'mobile',
      device: device.name,
      id: device.id,
      kind: device.kind,
      ...status,
      // Additive Apple-OS discriminant; Apple devices only. Gate on the platform
      // (not just field presence) so a non-Apple record with a stray appleOs never
      // surfaces it.
      ...(isApplePlatform(device.platform) && device.appleOs ? { appleOs: device.appleOs } : {}),
    },
  };
}
