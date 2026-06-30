import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo, Platform, PlatformSelector } from '../../kernel/device.ts';
import type { Interactor, RunnerContext } from '../interactor-types.ts';
import type { DeviceInventoryRequest } from '../platform-inventory.ts';
import type { CapabilityBucket } from '../platform-descriptor/types.ts';
// Daemon-owned facet types are TYPE-ONLY imports (erased under verbatimModuleSyntax),
// so referencing them here forms no runtime cycle — mirroring the established pattern
// in src/core/command-descriptor/registry.ts, which type-imports from src/daemon. The
// `providers` / `recording` / `appLog` / `perf` facets are DECLARED here so the plugin
// shape matches plans/perfect-shape.md §5.1, but are intentionally left UNPOPULATED by
// the builtins in this foundation slice; wiring them is Phase 3 step (b)/(c) work (see
// plans/phase3-platform-plugin-progress.md) and must port the daemon column logic
// verbatim, pinned by a table-equivalence parity test before any hand table is deleted.
import type { PlatformProviderResolvers } from '../../daemon/request-platform-providers.ts';
import type {
  IosSimulatorRecordingRequest,
  RecordingProcess,
} from '../../daemon/recording-provider.ts';
import type { AppLogResult, AppLogStartRequest } from '../../daemon/app-log.ts';
import type { LogBackend } from '../../daemon/network-log.ts';

/**
 * The platform-plugin contract (plans/perfect-shape.md §5.1, ADR-0009).
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
   * reads from a `CommandCapability` (parity-checked against the existing
   * `platformDescriptors` registry). `supportsByDefault` is reserved for the
   * step-(b) relocation of the `supports()` device closures — left undefined
   * here so those closures stay verbatim in `capabilities.ts` for now.
   */
  readonly capability: {
    readonly bucket: CapabilityBucket;
    supportsByDefault?(device: DeviceInfo): boolean;
  };
  /** DECLARED for step (b); unpopulated in this foundation slice. See module header. */
  readonly providers?: () => Partial<PlatformProviderResolvers>;
  /** DECLARED for step (b); unpopulated in this foundation slice. See module header. */
  readonly recording?: { start(request: IosSimulatorRecordingRequest): RecordingProcess };
  /** DECLARED for step (b); unpopulated in this foundation slice. See module header. */
  readonly appLog?: {
    start(request: AppLogStartRequest): Promise<AppLogResult>;
    logBackend(device: DeviceInfo): LogBackend;
  };
  /** DECLARED for step (c); unpopulated in this foundation slice. See module header. */
  readonly perf?: { collect(device: DeviceInfo): Promise<Record<string, unknown>> };
};

// The single registry instance: leaf platform -> owning plugin. A family plugin
// is registered once per leaf platform it owns, so `getPlugin('ios')` and
// `getPlugin('macos')` resolve to the SAME Apple plugin object.
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

/** The leaf platforms that currently carry a plugin, in registration order. */
export function registeredPlatforms(): Platform[] {
  return [...registry.keys()];
}
