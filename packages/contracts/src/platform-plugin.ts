import type { DeviceInfo, Platform, PlatformSelector } from '@agent-device/kernel/device';
import type { PlatformGatedProviderResolverKey } from './platform-providers.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';

/**
 * The platform-plugin contract (ADR-0009).
 *
 * One plugin owns one platform FAMILY: a plugin may cover several leaf
 * {@link Platform} literals (the Apple plugin owns both `ios` and `macos`,
 * folding in the eventual macOS unwind). The plugin's only job is to stop
 * core/daemon from BRANCHING on platform — it WRAPS today's existing factories
 * and discovery, it does NOT homogenize the irreducible leaf code (XCTest
 * synthesis, adb/idb), which stays exactly where it is.
 *
 * Imports are TYPE-ONLY; the concrete leaf code is reached through LAZY dynamic
 * `import()` inside `createInteractor`, preserving the
 * CLI cold-start laziness that today's `getInteractor` switch relies on.
 *
 * Root-composed columns (step b.3, issue #974): each is declared ONLY once it is
 * populated by wrapping the existing daemon branch AND pinned by a table-equivalence
 * parity test before a real call-site routes through it. A facet's type stays
 * PLATFORM-NEUTRAL and composition-owned (never the iOS-simulator-shaped provider seam):
 * {@link PlatformPlugin.providers} carries the per-family platform-gated request
 * provider resolver list (replaces the hand `device.platform === …` gate in
 * `request-platform-providers.ts`, pinned by the providers routing parity test). The
 * docs/adr/0009-apple-platform-consolidation.md (tracked in issue #974).
 */
export type PlatformPlugin = {
  readonly id: string;
  /** Leaf platforms this plugin owns (e.g. `['ios', 'macos']` for Apple). */
  readonly platforms: readonly Platform[];
  /** The multi-platform family selector, when the plugin owns more than one leaf (`apple`). */
  readonly familySelector?: PlatformSelector;
  /** Lazily builds the {@link Interactor} for `device` — wraps today's `getInteractor` switch arm. */
  createInteractor(device: DeviceInfo, runner: RunnerContext): Promise<Interactor>;
  /**
   * The request-scope provider facet (issue #974). `platformGatedResolvers`
   * declares which PLATFORM-GATED request provider resolvers apply to this family's
   * devices — the DATA that replaces the hand `device.platform === …` gate formerly
   * open-coded inside each descriptor's `resolve` in
   * src/platform-runtime/request-providers.ts. The canonical root composition owns the resolver
   * functions, their wrapper composition, and the request-scope concurrency isolation;
   * this facet supplies only the per-family gate (a plain string list, the keys
   * type-only in the plugin). Focused command transports that are not family-gated
   * are intentionally NOT part of the facet and stay ungated in the composition.
   * Every family carries this facet (each
   * owns at least one platform-specific resolver); a device on an unregistered platform
   * resolves to no gated resolvers, matching the former hand gate. Pinned by the
   * providers routing parity test.
   */
  readonly providers?: {
    readonly platformGatedResolvers: readonly PlatformGatedProviderResolverKey[];
  };
};
