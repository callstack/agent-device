import type { Platform } from '../../kernel/device.ts';
import type { PlatformDescriptor } from './types.ts';

/**
 * The additive single source of truth for the platform→capability-bucket fan-out
 * and the Apple-platform predicate (ADR-0009, Phase 3 step 1).
 *
 * Each row is copied VERBATIM from the facts the hand-authored control flow
 * implies today:
 *  - `capabilityBucket` — the bucket `selectCapabilityForPlatform` returned for
 *                         the platform (`ios`/`macos`→`apple`, `android`→`android`,
 *                         `linux`→`linux`, `web`→`web`).
 *  - `isApple`          — whether `isApplePlatform` is true for the leaf platform
 *                         (`ios`/`macos` only).
 *
 * `as const satisfies` pins each literal while checking the shape, and the row
 * order matches the `PLATFORMS` tuple so the parity test can prove totality.
 */
export const platformDescriptors = [
  { platform: 'ios', capabilityBucket: 'apple', isApple: true },
  { platform: 'macos', capabilityBucket: 'apple', isApple: true },
  { platform: 'android', capabilityBucket: 'android', isApple: false },
  { platform: 'linux', capabilityBucket: 'linux', isApple: false },
  { platform: 'web', capabilityBucket: 'web', isApple: false },
] as const satisfies readonly PlatformDescriptor[];

/** The union of leaf platforms that carry a descriptor row. */
type CoveredPlatform = (typeof platformDescriptors)[number]['platform'];

/**
 * Compile-time totality, mirroring the exhaustive `never` of the hand switch this
 * registry replaces: if a new leaf platform is added to `PLATFORMS` without a row
 * here, `Platform` no longer extends `CoveredPlatform` and this alias resolves to
 * `false`, which violates the `extends true` constraint and fails the build. The
 * value-level coverage (same order) is asserted by the parity test.
 */
type AssertTrue<T extends true> = T;
export type PlatformDescriptorsAreTotal = AssertTrue<
  [Platform] extends [CoveredPlatform] ? true : false
>;
