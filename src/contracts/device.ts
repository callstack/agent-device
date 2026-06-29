import type { DeviceKind, DeviceTarget, Platform } from '../kernel/device.ts';
import type { TargetShutdownResult } from '../target-shutdown-contract.ts';

/**
 * Closed result of the `boot` command. Mirrors the daemon handler's only
 * success return EXACTLY (src/daemon/handlers/session-state.ts) — the fixed
 * object literal `{ platform, target, device, id, kind, booted }`. The handler
 * spreads nothing, so this shape is intentionally closed.
 */
export type BootCommandResult = {
  platform: Platform;
  target: DeviceTarget;
  /** Human-readable device name (`device.name`). */
  device: string;
  /** Stable device id (`device.id`). */
  id: string;
  kind: DeviceKind;
  /** Always `true` on the success path. */
  booted: true;
};

/**
 * Closed result of the `shutdown` command. Mirrors the daemon handler's success
 * return EXACTLY (src/daemon/handlers/session-state.ts) — the fixed object
 * literal `{ platform, target, device, id, kind, shutdown }`. The `shutdown`
 * field is the raw {@link TargetShutdownResult} from `shutdownDeviceTarget`.
 */
export type ShutdownCommandResult = {
  platform: Platform;
  target: DeviceTarget;
  /** Human-readable device name (`device.name`). */
  device: string;
  /** Stable device id (`device.id`). */
  id: string;
  kind: DeviceKind;
  shutdown: TargetShutdownResult;
};
