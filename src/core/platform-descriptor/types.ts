import type { Platform } from '../../kernel/device.ts';

/**
 * The capability-bucket key a leaf {@link Platform} reads from a
 * {@link CommandCapability}. These are exactly the per-family keys of
 * `CommandCapability` (`apple` / `android` / `linux` / `web`) — the buckets the
 * hand-authored `selectCapabilityForPlatform` switch fanned each platform into.
 */
export type CapabilityBucket = 'apple' | 'android' | 'linux' | 'web';

/**
 * The single additive platform-descriptor shape (ADR-0009, Phase 3 step 1).
 *
 * Per leaf platform this carries, side-by-side, the two facts that today are
 * implied by hand-written control flow:
 *  - `capabilityBucket` — which `CommandCapability` family the platform reads
 *                         (from the `selectCapabilityForPlatform` switch).
 *  - `isApple`          — whether the platform is an Apple platform
 *                         (mirrors `isApplePlatform` for leaf platforms).
 *
 * `Platform` stays sourced from `kernel/device.ts`; the registry only
 * `satisfies`-checks against it (it does not become its source), which keeps the
 * core→kernel layering one-directional and avoids an import cycle.
 */
export type PlatformDescriptor = {
  platform: Platform;
  capabilityBucket: CapabilityBucket;
  isApple: boolean;
};
