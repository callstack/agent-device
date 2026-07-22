import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo, Platform, PlatformSelector } from '../../kernel/device.ts';
import type { LogBackend } from '../../daemon/network-log.ts';
import type { RecordingBackendTag } from '../../daemon/handlers/record-trace-recording-backends.ts';
import type { PerfMetricsSamplerTag } from '../../daemon/handlers/session-perf.ts';
import type { PlatformGatedProviderResolverKey } from '../../daemon/request-platform-providers.ts';
import type { Interactor, RunnerContext } from '../interactor-types.ts';
import type { DeviceInventoryRequest } from '../../contracts/device-inventory.ts';

type CapabilityBucket = 'apple' | 'android' | 'linux' | 'web';

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
 * `import()` inside `createInteractor` / `discoverDevices`, preserving the
 * CLI cold-start laziness that today's `getInteractor` switch relies on.
 *
 * Daemon-owned columns (step b.3, issue #974): each is declared ONLY once it is
 * populated by wrapping the existing daemon branch AND pinned by a table-equivalence
 * parity test before a real call-site routes through it. A facet's type stays
 * PLATFORM-NEUTRAL and daemon-owned (never the iOS-simulator-shaped provider seam):
 * {@link PlatformPlugin.appLog} carries the neutral {@link LogBackend} resolver
 * (wraps `resolveLogBackend`, pinned by the daemon app-log routing parity test);
 * {@link PlatformPlugin.perf} carries the neutral perf-metrics support predicate
 * (wraps `supportsPlatformPerfMetrics`) plus the neutral {@link PerfMetricsSamplerTag}
 * resolver (wraps the per-platform metrics-sampling branch formerly open-coded in
 * `buildPerfResponseData`), both pinned by the daemon perf routing parity test;
 * {@link PlatformPlugin.recording} carries the neutral
 * {@link RecordingBackendTag} resolver (wraps the per-platform branch of
 * `resolveRecordingBackendForDevice`, pinned by the recording routing parity test);
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
  /** Lazily discovers devices for this family — wraps today's inventory if-chain branch. */
  discoverDevices(request: DeviceInventoryRequest): Promise<DeviceInfo[]>;
  /**
   * The capability facet. `bucket` is the {@link CapabilityBucket} this family
   * reads from a `CommandCapability`.
   *
   * `supportsByDefault` / `unsupportedHintByDefault` carry the per-command
   * `supports()` / `unsupportedHint()` device closures RELOCATED VERBATIM off the
   * command-descriptor facet (ADR-0009: relocate, never
   * flatten). They are keyed by command name and owned by the family that owns the
   * device's platform; `isCommandSupportedOnDevice` / `unsupportedHintForDevice`
   * consult the map for `getPlugin(device.platform)`, so a family with no entry for a
   * command (the key is absent) admits it unchanged. Only the Apple family carries
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
   * The daemon app-log facet (issue #974). `resolveBackend` wraps the platform
   * branch of `src/daemon/app-log.ts`'s `resolveLogBackend`, returning the neutral
   * {@link LogBackend} tag for `device`. Present only on families that have an
   * app-log backend (Apple + Android); left `undefined` for linux/web, where the
   * hand branch historically fell through to the `'android'` default — the daemon
   * lookup preserves that fallthrough, and the parity test pins the equivalence.
   */
  readonly appLog?: {
    resolveBackend(device: DeviceInfo): LogBackend;
  };
  /**
   * The daemon perf facet (issue #974). `supportsMetrics` wraps the platform
   * predicate `supportsPlatformPerfMetrics` in
   * `src/daemon/handlers/session-perf.ts`, reporting whether `device`'s platform
   * can produce session perf metrics (startup/fps/memory/cpu). Present only on
   * families that expose perf metrics (Apple + Android); left `undefined` for
   * linux/web, where the hand predicate returned `false` — the daemon lookup
   * preserves that fallthrough, and the daemon perf routing parity test pins the
   * equivalence.
   *
   * `metricsSamplerTag` returns the neutral {@link PerfMetricsSamplerTag} naming which
   * `perf metrics` sampler a device's family owns (`'apple'` / `'android'`), replacing
   * the `device.platform === 'android'` sampling branch formerly open-coded in
   * `buildPerfResponseData`. The daemon still OWNS the samplers and maps the tag back to
   * them (`PERF_METRICS_SAMPLERS_BY_TAG`), so core/platforms never carry the daemon-owned
   * sampling composition — exactly like {@link recording}'s tag. It is only ever consulted
   * after `supportsMetrics` gates the platform in, so it is present on the SAME families
   * (Apple + Android) and the parity test pins both to a verbatim copy of the former
   * branch. The `perf memory`/`perf frames` bodies and the Android-only native-collector
   * gate stay on their daemon branch until each clears the same gate.
   */
  readonly perf?: {
    supportsMetrics(device: DeviceInfo): boolean;
    metricsSamplerTag(device: DeviceInfo): PerfMetricsSamplerTag;
  };
  /**
   * The daemon recording facet (issue #974). `resolveBackendTag` wraps the
   * per-platform branch of `resolveRecordingBackendForDevice`
   * (src/daemon/handlers/record-trace-recording-backends.ts), returning the neutral
   * {@link RecordingBackendTag} for `device` (a DATA-ONLY string, type-only in the
   * plugin — exactly like {@link appLog}'s {@link LogBackend}). The daemon maps the tag
   * back to its own {@link RecordingBackend} instance, so core/platforms never construct
   * the daemon-owned backend objects. Present on families with a recording backend
   * (Apple + Android + web); left `undefined` for linux, where the hand branch fell
   * through to the unsupported backend — the daemon lookup preserves that fallthrough
   * (`?? 'unsupported'`), and the recording routing parity test pins the equivalence.
   */
  readonly recording?: {
    resolveBackendTag(device: DeviceInfo): RecordingBackendTag;
  };
  /**
   * The daemon request-scope provider facet (issue #974). `platformGatedResolvers`
   * declares which PLATFORM-GATED request provider resolvers apply to this family's
   * devices — the DATA that replaces the hand `device.platform === …` gate formerly
   * open-coded inside each descriptor's `resolve` in
   * src/daemon/request-platform-providers.ts. The daemon still OWNS the resolver
   * functions, their wrapper composition, and the request-scope concurrency isolation;
   * this facet supplies only the per-family gate (a plain string list, the keys
   * type-only in the plugin). The ungated resolvers (`appLogProvider` /
   * `recordingProvider`, which apply on every platform) are intentionally NOT part of
   * the facet and stay ungated in the daemon. Every family carries this facet (each
   * owns at least one platform-specific resolver); a device on an unregistered platform
   * resolves to no gated resolvers, matching the former hand gate. Pinned by the
   * providers routing parity test.
   */
  readonly providers?: {
    readonly platformGatedResolvers: readonly PlatformGatedProviderResolverKey[];
  };
};

// The single registry instance: leaf platform -> owning plugin. A family plugin
// is registered once per leaf platform it owns, so `getPlugin('apple')` and
// `getPlugin('apple')` resolve to the SAME Apple plugin object.
const registry = new Map<Platform, PlatformPlugin>();

/**
 * Registers `plugin` for each leaf platform it owns. Throws on a duplicate
 * registration so a double-owned platform is a hard error, not a silent
 * last-writer-wins.
 */
export function registerPlatformPlugin(plugin: PlatformPlugin): void {
  for (const platform of plugin.platforms) {
    if (registry.has(platform)) {
      throw new Error(`PlatformPlugin already registered for platform "${platform}"`);
    }
    registry.set(platform, plugin);
  }
}

/**
 * Returns the plugin for `platform`, throwing the SAME `UNSUPPORTED_PLATFORM`
 * AppError (identical code + message) that the hand-authored `getInteractor`
 * switch default threw, so routing through it is byte-identical.
 */
export function getPlugin(platform: Platform): PlatformPlugin {
  const plugin = registry.get(platform);
  if (!plugin) {
    throw new AppError('UNSUPPORTED_PLATFORM', `Unsupported platform: ${platform}`);
  }
  return plugin;
}

/** Non-throwing lookup, for call-sites that branch on plugin presence. */
export function tryGetPlugin(platform: Platform): PlatformPlugin | undefined {
  return registry.get(platform);
}

/**
 * @internal The leaf platforms that currently carry a plugin, in registration order.
 * Exposed for parity tests.
 */
export function registeredPlatforms(): Platform[] {
  return [...registry.keys()];
}
