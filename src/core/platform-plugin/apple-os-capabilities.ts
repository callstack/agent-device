import {
  isApplePlatform,
  isTvOsDevice,
  type AppleOS,
  type DeviceInfo,
} from '../../kernel/device.ts';

// ---------------------------------------------------------------------------
// Per-`AppleOS` capability data table (ADR-0009 "per-AppleOS capability table";
// perfect-shape §7 step d.5). This is the capability-axis sibling of the runner
// table `RUNNER_PLATFORM_PROFILES` (src/platforms/apple/core/apple-runner-platform.ts)
// and it encodes the SAME per-OS facts the Swift `#if os()` guards do: which Apple
// OS has touch input, multi-touch synthesis, a keyboard, device orientation, an
// app/device lifecycle, and a desktop host surface.
//
// DISCIPLINE (perfect-shape §7): the table holds ONLY the AppleOS-axis facts — it
// collapses the scattered `target !== 'tv'` / `platform !== 'macos'` / `isTvOsDevice`
// predicates into one lookup. The DEVICE-shaped nuance the closures still encode
// (simulator vs physical device — e.g. two-finger synthesis is iOS-*simulator* only)
// is NOT flattened into data; it stays in the reading closure. The predicate rewrite
// is behaviorless: `apple-os-capability-table-parity.test.ts` pins the table-driven
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
  /** `rotate` — device orientation. tvOS (focus-only) and macOS lack it. */
  readonly orientation: boolean;
  /**
   * Whether `clipboard` / `alert` / `settings` are reachable on a PHYSICAL device of
   * this OS. Only the macOS host exposes them without a simulator; the reading closure
   * still admits every Apple *simulator* via its own `kind === 'simulator'` check.
   */
  readonly physicalDeviceSurfaces: boolean;
  /**
   * `pinch` / `rotate-gesture` / `transform-gesture` — the two-finger multi-touch
   * SYNTHESIS input model. `false` on tvOS (no touch) and macOS (no multi-touch). The
   * reading closure further gates this to the simulator (physical iOS cannot synthesize),
   * which is device-shaped nuance kept OUT of the table on purpose.
   */
  readonly multiTouchSynthesis: boolean;
  /**
   * The OS-level reason a multi-touch gesture is refused: macOS has no multi-touch
   * input; tvOS has no touch input. `undefined` for the iOS family, whose only block
   * is the kind-shaped physical-device case handled in the hint closure.
   */
  readonly multiTouchUnsupportedHint?: string;
};

// iOS / iPadOS / visionOS are capability-identical under today's behavior: all are
// modeled as the touch iOS engine (`platform: 'ios'`, mobile target), so a stored
// `appleOs: 'ipados' | 'visionos'` must read exactly what the legacy target-based
// inference produced for an unlabeled iOS record. Sharing ONE frozen row keeps that
// invariant a reference identity (asserted by the parity test) and mirrors the iOS
// runner profile absorbing iPadOS.
const IOS_FAMILY_CAPABILITIES: AppleOsCapabilityProfile = {
  appAndDeviceLifecycle: true,
  keyboard: true,
  orientation: true,
  physicalDeviceSurfaces: false,
  multiTouchSynthesis: true,
};

export const APPLE_OS_CAPABILITIES: Record<AppleOS, AppleOsCapabilityProfile> = {
  ios: IOS_FAMILY_CAPABILITIES,
  ipados: IOS_FAMILY_CAPABILITIES,
  visionos: IOS_FAMILY_CAPABILITIES,
  // tvOS: focus-only (XCUIRemote), no touch — so no keyboard, orientation, or
  // multi-touch synthesis; but the app + device lifecycle (boot/install/home/
  // app-switcher) is supported like the rest of the mobile family.
  tvos: {
    appAndDeviceLifecycle: true,
    keyboard: false,
    orientation: false,
    physicalDeviceSurfaces: false,
    multiTouchSynthesis: false,
    multiTouchUnsupportedHint:
      'tvOS has no touch input — this gesture is supported on Android and the iOS simulator only.',
  },
  // macOS: an AppKit desktop host driving an already-running app. No app/device
  // lifecycle (nothing to boot/install/push, no springboard), no touch keyboard /
  // orientation, no multi-touch; but clipboard/alert/settings are reachable on the
  // host directly (no simulator required).
  macos: {
    appAndDeviceLifecycle: false,
    keyboard: false,
    orientation: false,
    physicalDeviceSurfaces: true,
    multiTouchSynthesis: false,
    multiTouchUnsupportedHint:
      'macOS automation has no multi-touch input — this gesture is supported on Android and the iOS simulator only.',
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
    multiTouchSynthesis: false,
  },
};

/**
 * The stored `AppleOS` discriminant for `device`, with the SAME "prefer the explicit
 * field, else infer from target" precedence that `resolveApplePlatformName` uses for
 * the runner name. Only meaningful for Apple devices (callers guard via
 * {@link appleOsCapabilities}).
 */
export function resolveDeviceAppleOs(
  device: Pick<DeviceInfo, 'platform' | 'target' | 'appleOs'>,
): AppleOS {
  // Real discovery sets `appleOs`; legacy/synthetic records without it fall back to
  // the target-based inference the capability predicates used before this table.
  if (device.appleOs) return device.appleOs;
  // Back-compat: a legacy persisted record may still carry the pre-collapse `macos`
  // leaf platform string (the type no longer allows it, hence the cast).
  if ((device.platform as string) === 'macos') return 'macos';
  if (isTvOsDevice(device)) return 'tvos';
  // iOS / iPadOS / visionOS are indistinguishable without discovery descriptors and
  // are capability-identical, so an unlabeled mobile Apple record collapses to `ios`.
  return 'ios';
}

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
