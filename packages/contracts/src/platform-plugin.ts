import type { DeviceInfo, Platform, PlatformSelector } from '@agent-device/kernel/device';
import type { PlatformGatedProviderResolverKey } from './platform-providers.ts';
import type { Interactor, RunnerContext } from './interactor-types.ts';

type CapabilityBucket = 'apple' | 'android' | 'harmonyos' | 'vega' | 'linux' | 'web';

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
 * Daemon-owned columns (step b.3, issue #974): each is declared ONLY once it is
 * populated by wrapping the existing daemon branch AND pinned by a table-equivalence
 * parity test before a real call-site routes through it. A facet's type stays
 * PLATFORM-NEUTRAL and daemon-owned (never the iOS-simulator-shaped provider seam):
 * {@link PlatformPlugin.perf} carries the neutral perf-observation support predicate,
 * pinned by the daemon perf routing parity test;
 * {@link PlatformPlugin.providers} carries the per-family platform-gated request
 * provider resolver list (replaces the hand `device.platform === …` gate in
 * `request-platform-providers.ts`, pinned by the providers routing parity test). The
 * remaining perf work (the `perf memory`/`perf frames` bodies and the Android-only
 * native-collector gate) stays on its daemon branch as the source of truth until it
 * clears the same gate. See
 * docs/adr/0009-apple-platform-consolidation.md (tracked in issue #974).
 */
export type PlatformPlugin = {
  /** Plugin/family id; also the capability-matrix bucket key for its platforms. */
  readonly id: string;
  /** Leaf platforms this plugin owns (e.g. `['ios', 'macos']` for Apple). */
  readonly platforms: readonly Platform[];
  /** The multi-platform family selector, when the plugin owns more than one leaf (`apple`). */
  readonly familySelector?: PlatformSelector;
  /** Lazily builds the {@link Interactor} for `device` — wraps today's `getInteractor` switch arm. */
  createInteractor(device: DeviceInfo, runner: RunnerContext): Promise<Interactor>;
  /**
   * The capability facet. `bucket` is the {@link CapabilityBucket} this family
   * reads from a `CommandCapability`.
   *
   * `supportsByDefault` / `unsupportedHintByDefault` carry the per-command
   * `supports()` / `unsupportedHint()` device closures RELOCATED VERBATIM off the
   * command-descriptor facet (ADR-0009: relocate, never
   * flatten). They are keyed by command name and owned by the family that owns the
   * device's platform; `isCommandSupportedOnDevice` / `unsupportedHintForDevice`
   * consult the root platform-plugin registry, so a family with no entry for a command
   * (the key is absent) admits it unchanged. Only the Apple family carries
   * entries today — every relocated closure is a no-op (returns `true` / `undefined`)
   * on non-Apple devices, proven byte-for-byte by the parity gate before the
   * command-facet closures were deleted.
   */
  readonly capability: {
    readonly bucket: CapabilityBucket;
    readonly supportsByDefault?: Readonly<Record<string, (device: DeviceInfo) => boolean>>;
    readonly unsupportedHintByDefault?: Readonly<
      Record<string, (device: DeviceInfo) => string | undefined>
    >;
  };
  /**
   * The daemon perf facet (issue #974). `supportsObservations` reports whether a device family
   * can produce the explicit `perf frames` or `perf memory` observations. Present only on
   * Apple, Android, and HarmonyOS; factless families omit the facet.
   */
  readonly perf?: {
    supportsObservations(device: DeviceInfo): boolean;
  };
  /**
   * The daemon request-scope provider facet (issue #974). `platformGatedResolvers`
   * declares which PLATFORM-GATED request provider resolvers apply to this family's
   * devices — the DATA that replaces the hand `device.platform === …` gate formerly
   * open-coded inside each descriptor's `resolve` in
   * src/daemon/request-platform-providers.ts. The daemon still OWNS the resolver
   * functions, their wrapper composition, and the request-scope concurrency isolation;
   * this facet supplies only the per-family gate (a plain string list, the keys
   * type-only in the plugin). Focused command transports that are not family-gated
   * are intentionally NOT part of the facet and stay ungated in the daemon.
   * Every family carries this facet (each
   * owns at least one platform-specific resolver); a device on an unregistered platform
   * resolves to no gated resolvers, matching the former hand gate. Pinned by the
   * providers routing parity test.
   */
  readonly providers?: {
    readonly platformGatedResolvers: readonly PlatformGatedProviderResolverKey[];
  };
};
