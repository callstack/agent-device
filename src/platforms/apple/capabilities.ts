import {
  isApplePlatform,
  resolveDeviceAppleOs,
  type AppleOS,
  type DeviceInfo,
} from '../../kernel/device.ts';

// ---------------------------------------------------------------------------
// Per-`AppleOS` capability data table (ADR-0009 "per-AppleOS capability table").
// This is the capability-axis sibling of the runner
// table `RUNNER_PLATFORM_PROFILES` (src/platforms/apple/core/apple-runner-platform.ts)
// and it encodes the SAME per-OS facts the Swift `#if os()` guards do: keyboard,
// device orientation, app/device lifecycle, and desktop host surfaces.
//
// DISCIPLINE (ADR-0009): the table holds ONLY the AppleOS-axis facts — it
// collapses the scattered `target !== 'tv'` / `platform !== 'macos'` / `isTvOsDevice`
// predicates into one lookup. Gesture synthesis has its own shared policy in
// `contracts/apple-multitouch-support.ts`; keeping it out of this table prevents a
// second source of truth. The predicate rewrite is behaviorless:
// `apple-os-capability-table-parity.test.ts` pins the table-driven
// closures byte-for-byte against a verbatim copy of the original predicates across the
// full {command x sample-device} matrix (iOS/iPadOS/tvOS/macOS/visionOS).
// ---------------------------------------------------------------------------

export type AppleOsCapabilityProfile = {
  /**
   * `install` / `boot` / `reinstall` / `install-from-source` / `push` / `home` /
   * `app-switcher` — the app + device lifecycle and springboard surfaces. `false`
   * on the macOS host, which drives an already-running app (nothing to boot/install/
   * push, no springboard home or app switcher).
   */
  readonly appAndDeviceLifecycle: boolean;
  /** `keyboard` — hardware/text keyboard input. tvOS (focus-only) and macOS lack it. */
  readonly keyboard: boolean;
  /** `orientation` — device orientation. tvOS (focus-only) and macOS lack it. */
  readonly orientation: boolean;
  /**
   * Whether `clipboard` / `alert` / `settings` are reachable on a PHYSICAL device of
   * this OS. Only the macOS host exposes them without a simulator; the reading closure
   * still admits every Apple *simulator* via its own `kind === 'simulator'` check.
   */
  readonly physicalDeviceSurfaces: boolean;
};

// iOS and iPadOS share this platform capability profile. Gesture synthesis support is
// intentionally owned by the separate shared gesture policy.
const IOS_FAMILY_CAPABILITIES: AppleOsCapabilityProfile = {
  appAndDeviceLifecycle: true,
  keyboard: true,
  orientation: true,
  physicalDeviceSurfaces: false,
};

export const APPLE_OS_CAPABILITIES: Record<AppleOS, AppleOsCapabilityProfile> = {
  ios: IOS_FAMILY_CAPABILITIES,
  ipados: IOS_FAMILY_CAPABILITIES,
  visionos: {
    appAndDeviceLifecycle: true,
    keyboard: true,
    orientation: true,
    physicalDeviceSurfaces: false,
  },
  // tvOS: focus-only (XCUIRemote), so no keyboard or orientation; the app + device
  // lifecycle (boot/install/home/app-switcher) is supported like the mobile family.
  tvos: {
    appAndDeviceLifecycle: true,
    keyboard: false,
    orientation: false,
    physicalDeviceSurfaces: false,
  },
  // macOS: an AppKit desktop host driving an already-running app. No app/device
  // lifecycle (nothing to boot/install/push, no springboard), keyboard, or orientation;
  // clipboard/alert/settings are reachable on the host directly (no simulator required).
  macos: {
    appAndDeviceLifecycle: false,
    keyboard: false,
    orientation: false,
    physicalDeviceSurfaces: true,
  },
  // watchOS is reserved in the `AppleOS` type but never produced by discovery or by
  // `resolveDeviceAppleOs` inference (XCUITest cannot drive watchOS UI — ADR-0009's
  // unsupported sentinel). This row is therefore unreachable today; the all-`false`
  // sentinel keeps the `Record<AppleOS, ...>` exhaustive without granting anything.
  watchos: {
    appAndDeviceLifecycle: false,
    keyboard: false,
    orientation: false,
    physicalDeviceSurfaces: false,
  },
};

/**
 * The {@link AppleOsCapabilityProfile} for `device`, or `undefined` for a non-Apple
 * platform (which has no AppleOS row). The capability closures fall back to their
 * verbatim non-Apple verdicts when this returns `undefined`, so consulting the table
 * only for the Apple family leaves admission for android/linux/web unchanged.
 */
export function appleOsCapabilities(
  device: Pick<DeviceInfo, 'platform' | 'target' | 'appleOs'>,
): AppleOsCapabilityProfile | undefined {
  return isApplePlatform(device.platform)
    ? APPLE_OS_CAPABILITIES[resolveDeviceAppleOs(device)]
    : undefined;
}
