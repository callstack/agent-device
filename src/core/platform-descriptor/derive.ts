import type { Platform } from '../../kernel/device.ts';
import type { CommandCapability } from '../capabilities.ts';
import type { CapabilityBucket, PlatformDescriptor } from './types.ts';

/**
 * Pure folds over the additive {@link PlatformDescriptor} registry (ADR-0009,
 * Phase 3 step 1). These reproduce facts that today live in hand-written control
 * flow so the parity test can prove byte-for-byte equality before the hand
 * switch is deleted.
 *
 * This module only TYPE-imports from {@link CommandCapability} (erased at runtime
 * under `verbatimModuleSyntax`) and from `kernel/device.ts`, so wiring it into
 * `capabilities.ts` forms no runtime cycle — mirroring `command-descriptor/derive.ts`.
 */

/**
 * Reproduces `selectCapabilityForPlatform`'s bucket selection EXACTLY: the leaf
 * `platform` is mapped to its `capabilityBucket` via the registry, then that
 * family is read off the `capability` (returning `undefined` when the family is
 * absent, identical to the hand switch).
 *
 * The registry's compile-time totality (`PlatformDescriptorsAreTotal`) plus the
 * parity test's order-equality assertion guarantee `find` always resolves; the
 * throw is the unreachable counterpart of the hand switch's `never` default.
 */
export function deriveCapabilityForPlatform(
  descriptors: readonly PlatformDescriptor[],
  capability: CommandCapability,
  platform: Platform,
): CommandCapability[CapabilityBucket] {
  const descriptor = descriptors.find((entry) => entry.platform === platform);
  if (!descriptor) {
    throw new Error(`No PlatformDescriptor registered for platform "${platform}"`);
  }
  return capability[descriptor.capabilityBucket];
}

/** Reproduces the set of leaf platforms for which `isApplePlatform` is true. */
export function deriveApplePlatforms(descriptors: readonly PlatformDescriptor[]): Platform[] {
  return descriptors
    .filter((descriptor) => descriptor.isApple)
    .map((descriptor) => descriptor.platform);
}
