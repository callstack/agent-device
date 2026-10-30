import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * What the runner reads of a physical iPhone's control facet: its transport backend, its CoreDevice
 * tunnel address, and its own readiness report. The runner declares the slice it consults; the
 * Apple physical-device control derives its full facet from it.
 */
export type IosPhysicalDeviceBackend = 'coredevice' | 'xctest';

/**
 * Only the CoreDevice tunnel address is resolved here. Which transport a runner
 * command uses is decided by the route resolver, which reaches this at all only
 * after usbmux has reported the device unattached.
 */
export type IosPhysicalDeviceTunnel = { tunnelIp: string | null };

export type IosPhysicalDeviceRunnerControl = {
  readonly backend: IosPhysicalDeviceBackend;
  resolveTunnel(device: DeviceInfo, timeoutBudgetMs?: number): Promise<IosPhysicalDeviceTunnel>;
  /**
   * The device's own report on whether it can run development tooling (#2683). Only CoreDevice
   * answers this, so an XCTest-backed device reports that it could not be read rather than lending
   * the runner a guess to fail on.
   */
  readDeviceReadiness(
    device: DeviceInfo,
    timeoutBudgetMs?: number,
    signal?: AbortSignal,
  ): Promise<IosDeviceReadiness>;
};

/**
 * The device's own report on whether it can host development tooling (#2683), published through the
 * physical-device control facet.
 *
 * The two states are kept apart because the device reports them apart and they fail apart. A device
 * with Developer Mode off cannot serve its developer disk image either; an image that is not up on a
 * device with the toggle on is its own failure. Deciding which one to name is the reader's job in
 * `runner-device-readiness.ts`.
 *
 * The remedy travels with the states in {@link IosDeviceReadinessRemedies} rather than being worded
 * again at each site that publishes one, so the runner preflight and the `devicectl` output path
 * cannot drift apart while describing the same fix.
 *
 * `available: false` is the answer when no state can be established — the device could not be read,
 * or it read an answer that could not have been true at the moment it was asked. It carries no
 * verdict, because an unreadable device is not a diagnosed one.
 */
export type IosDeviceReadiness =
  | Readonly<{
      available: true;
      developerMode: IosDeveloperModeState;
      developerDiskImage: IosDeveloperDiskImageState;
      remedies: IosDeviceReadinessRemedies;
    }>
  | Readonly<{
      available: false;
      reason: 'device_readiness_unreadable';
      hint: string;
    }>;

/**
 * What to tell a caller about each state the device can report, published with the report. Both
 * strings are owned by Apple's `core/devicectl.ts`, which answers the same two complaints when they
 * arrive as tool output instead of as a device fact (#2683).
 */
export type IosDeviceReadinessRemedies = Readonly<{
  developerModeOff: string;
  developerDiskImageUnavailable: string;
}>;

/** How a device reports its own Settings > Privacy & Security > Developer Mode toggle. */
export type IosDeveloperModeState = 'enabled' | 'disabled' | 'unknown';

/** How a device reports the services that serve its developer disk image. */
export type IosDeveloperDiskImageState = 'available' | 'unavailable' | 'unknown';
