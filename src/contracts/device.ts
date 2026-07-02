import type { AppleOS, DeviceKind, DeviceTarget, PublicPlatform } from '../kernel/device.ts';
import type { TargetShutdownResult } from '../target-shutdown-contract.ts';

/**
 * Closed result of the `boot` command. Mirrors the daemon handler's only
 * success return EXACTLY (src/daemon/handlers/session-state.ts) — the fixed
 * object literal `{ platform, target, device, id, kind, booted }` plus the
 * additive `appleOs` discriminant, emitted only for Apple devices.
 */
export type BootCommandResult = {
  platform: PublicPlatform;
  target: DeviceTarget;
  /** Human-readable device name (`device.name`). */
  device: string;
  /** Stable device id (`device.id`). */
  id: string;
  kind: DeviceKind;
  /** Always `true` on the success path. */
  booted: true;
  /**
   * Additive Apple-OS discriminant (`device.appleOs`): iPhone/iPad/tvOS/visionOS/macOS.
   * Present only for Apple devices; absent for non-Apple platforms. `platform` stays the
   * leaf (`ios`/`macos`) — this is an extra field, not a replacement.
   */
  appleOs?: AppleOS;
};

/**
 * Closed result of the `shutdown` command. Mirrors the daemon handler's success
 * return EXACTLY (src/daemon/handlers/session-state.ts) — the fixed object
 * literal `{ platform, target, device, id, kind, shutdown }` plus the additive
 * `appleOs` discriminant (Apple devices only). The `shutdown` field is the raw
 * {@link TargetShutdownResult} from `shutdownDeviceTarget`.
 */
export type ShutdownCommandResult = {
  platform: PublicPlatform;
  target: DeviceTarget;
  /** Human-readable device name (`device.name`). */
  device: string;
  /** Stable device id (`device.id`). */
  id: string;
  kind: DeviceKind;
  shutdown: TargetShutdownResult;
  /**
   * Additive Apple-OS discriminant (`device.appleOs`): iPhone/iPad/tvOS/visionOS/macOS.
   * Present only for Apple devices; absent for non-Apple platforms. `platform` stays the
   * leaf (`ios`/`macos`) — this is an extra field, not a replacement.
   */
  appleOs?: AppleOS;
};
