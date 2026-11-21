import type { ManagedWebBackend } from './managed-web-backend.ts';
import type { DoctorCheck } from './doctor.ts';
import type { HostDiagnosticsContext } from './host-diagnostics.ts';
import type { InventoryPlatformModule, PlatformModuleRegistry } from './platform-module.ts';
import type { LinuxToolProvider } from './linux-tool-provider.ts';
import type { PlatformRuntimeModule } from './platform-runtime-operations.ts';
import type { WebProvider } from './web-provider.ts';
import type { VegaToolProvider } from './vega-tool-provider.ts';
import type { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo, Platform, PlatformSelector } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
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
  /**
   * Lazily builds the {@link Interactor} for `device` — wraps today's `getInteractor` switch arm.
   * `host` is the environment the calling runtime captured at its entry point. Plugins are
   * module-level and shared by every runtime in a process, so the host arrives per call — never
   * bound at plugin construction — and is the same object the runtime's deps and request-bound
   * facets carry.
   */
  createInteractor(
    device: DeviceInfo,
    runner: RunnerContext,
    host: HostEnvironment,
  ): Promise<Interactor>;
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

export type WebPlatformOperations = ManagedWebBackend &
  Readonly<{
    cleanupOrphans(openWebSessionNames: readonly string[]): Promise<void>;
    browserLifecycleCheck(stateDir: string): Promise<DoctorCheck>;
    createProvider(session: string): Promise<WebProvider>;
    resolveRequestProvider(): Promise<WebProvider | undefined>;
  }>;

export type WebPlatformRegistration = Readonly<{
  family: 'web';
  inventoryModule: InventoryPlatformModule<'web'>;
  runtimeModule: PlatformRuntimeModule & { readonly family: 'web' };
  createInteractor: PlatformPlugin['createInteractor'];
  withRequestProvider<T>(provider: WebProvider, task: () => Promise<T>): Promise<T>;
  operations: WebPlatformOperations;
}>;

export type WebPlatformSelection = Readonly<{
  active?: WebPlatformRegistration;
  get(): WebPlatformRegistration;
}>;

/** The host-side checks the Vega plugin answers for the daemon's doctor. */
export type VegaPlatformOperations = Readonly<{
  toolchainCheck(context: HostDiagnosticsContext): Promise<DoctorCheck>;
}>;

export type VegaPlatformRegistration = Readonly<{
  family: 'vega';
  inventoryModule: InventoryPlatformModule<'vega'>;
  runtimeModule: PlatformRuntimeModule & { readonly family: 'vega' };
  createInteractor: PlatformPlugin['createInteractor'];
  withRequestProvider<T>(provider: VegaToolProvider, task: () => Promise<T>): Promise<T>;
  operations: VegaPlatformOperations;
}>;

export type VegaPlatformSelection = Readonly<{
  active?: VegaPlatformRegistration;
  get(): VegaPlatformRegistration;
}>;

/**
 * What the core asks of the HarmonyOS plugin: the toolchain probe that answers `doctor --platform
 * harmonyos`. Every other HarmonyOS operation — HDC discovery, probing, interaction, capture,
 * recording, performance, and the plugin's own toolchain `PATH` — the package owns, because it runs
 * them through the host it was set up with.
 */
export type HarmonyPlatformOperations = Readonly<{
  toolchainCheck(): Promise<DoctorCheck>;
}>;

export type HarmonyPlatformRegistration = Readonly<{
  family: 'harmonyos';
  inventoryModule: InventoryPlatformModule<'harmonyos'>;
  runtimeModule: PlatformRuntimeModule & { readonly family: 'harmonyos' };
  createInteractor: PlatformPlugin['createInteractor'];
  operations: HarmonyPlatformOperations;
}>;

/**
 * How the running process answers for the HarmonyOS family, installed or not. `get()` raises the
 * selection's own typed outcome when the plugin is absent or failed to load, and `toolchainCheck`
 * of the toolchain row comes from it either way: `doctor --platform harmonyos` names the install
 * command rather than reporting nothing.
 */
export type HarmonyPlatformSelection = Readonly<{
  active?: HarmonyPlatformRegistration;
  get(): HarmonyPlatformRegistration;
}>;

/**
 * What the core asks of the Linux plugin: the toolchain probe that answers `doctor --platform
 * linux`, and the request scope the family owns. The desktop capture and every interaction the
 * family runs go through the registration's runtime and interactor, which use the host the plugin
 * was set up with.
 */
export type LinuxPlatformOperations = Readonly<{
  toolchainCheck(): Promise<DoctorCheck>;
}>;

export type LinuxPlatformRegistration = Readonly<{
  family: 'linux';
  inventoryModule: InventoryPlatformModule<'linux'>;
  runtimeModule: PlatformRuntimeModule & { readonly family: 'linux' };
  createInteractor: PlatformPlugin['createInteractor'];
  withRequestProvider<T>(provider: LinuxToolProvider, task: () => Promise<T>): Promise<T>;
  operations: LinuxPlatformOperations;
}>;

/**
 * How the running process answers for the Linux family, installed or not. `get()` raises the
 * selection's own typed outcome when the plugin is absent or failed to load, so `doctor --platform
 * linux` names the install command rather than reporting nothing.
 */
export type LinuxPlatformSelection = Readonly<{
  active?: LinuxPlatformRegistration;
  get(): LinuxPlatformRegistration;
}>;

export type PlatformPluginSet<Plugin extends PlatformPlugin = PlatformPlugin> =
  PlatformModuleRegistry<{ family: Platform; plugin: Plugin }>;

export type PlatformModuleSelection = Readonly<{
  interactors: PlatformPluginSet;
  web: WebPlatformSelection;
  vega: VegaPlatformSelection;
  harmony: HarmonyPlatformSelection;
  linux: LinuxPlatformSelection;
  inventoryModules: readonly InventoryPlatformModule[];
  runtimeModules: readonly PlatformRuntimeModule[];
  reportAbsent(family: Platform): AppError;
  assertSelectionCurrent(family: Platform): void;
}>;
