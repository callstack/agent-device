import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type {
  LeaseLifecycleProvider,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';
import type {
  PluginCleanupOutcome,
  PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';
import type { ClaimRecoveryGatewayFactory } from '@agent-device/daemon-contracts/device-claim-recovery';
import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { InteractorResolution } from '../../core/interactor-resolution.ts';
import type { PlatformOwnerLifecycle } from '../../core/platform-owner-lifecycle.ts';
import type { ProviderDeviceAdmission } from '../../core/provider-device-admission.ts';
import type { RequestRouterDeps } from '../request-router.ts';

/**
 * Every capability the daemon runtime cannot construct for itself: the platform and provider
 * runtimes, host diagnostics, credential fingerprinting, resource cleanup, the platform lifecycle
 * owners, and the request-router inputs that name them. The server owns the paths, the policy, and
 * the session store, and asks the root for the rest through a `composeDeps` factory — the process
 * root's implementation is `src/daemon-composition.ts` (ADR 0019). The factory is required for
 * daemon startup and runtime tests. `leaseLifecycleProvider` and `recoverExpiredLease` are
 * optional hooks, supplied only when a provider supports them.
 */
export type DaemonRuntimeDeps = Readonly<{
  ownedProcessRecords: OwnedProcessRecordStore;
  hostDiagnostics: HostDiagnostics;
  ownerLifecycle: PlatformOwnerLifecycle;
  /**
   * Shuts every provider down, each runtime and then its plugin's own cleanup. The composition owns
   * what a provider is made of, so the server calls this once per shutdown path and never reaches
   * into a runtime.
   */
  shutdownProviderRuntimes: () => Promise<readonly PluginCleanupOutcome[]>;
  /**
   * Every provider plugin the composition saw, active or failed. Data only: this server publishes
   * it in the daemon registration and records each failed entry as a `provider_plugin_failed`
   * diagnostic, so log emission stays in this module.
   */
  pluginInventory: readonly PluginInventoryEntry[];
  interactorResolution: InteractorResolution;
  providerDeviceAdmission: ProviderDeviceAdmission;
  cleanupManagedWebOrphans: (
    params: Readonly<{
      stateDir: string;
      openWebSessionNames: readonly string[];
      ownedProcessRecords?: OwnedProcessRecordStore;
    }>,
  ) => Promise<void>;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  providerRuntimeIds: readonly string[];
  recoverExpiredLease?: ProviderExpiredLeaseRecovery;
  recoverableProviderIds: readonly string[];
  /** The runtime gateway every lifecycle and recovery step in this server runs through. */
  deviceRuntimeGateway: RequestRouterDeps['deviceRuntimeGateway'];
  /** The resource-cleanup surface the session teardowns run through. */
  platformResourceCleanup: RequestRouterDeps['platformResourceCleanup'];
  /** The owner-scoped gateway factory the startup claim reconciliation composes. */
  claimRecoveryGateway: ClaimRecoveryGatewayFactory;
  /**
   * The root-composed half of `createRequestHandler`'s inputs; the server adds the rest.
   * Optionality mirrors `RequestRouterDeps`. Facts the server also reads outside any request —
   * the gateway, the cleanup surface, the claim-recovery factory, and the lease-provider facts —
   * are declared once at the top level of the deps, not here.
   */
  requestRouter: Pick<
    RequestRouterDeps,
    | 'requestPlatformProviders'
    | 'deviceInventoryGateways'
    | 'platformServices'
    | 'androidObservation'
    | 'providerCredentials'
    | 'createCommandSurface'
    | 'cloudArtifactProvider'
    | 'providerAppCatalog'
    | 'providerDeviceRuntimeScope'
  >;
}>;

/** Everything the composition factory needs that the server owns: paths, policy, and the store. */
export type DaemonRuntimeDepsInput = Readonly<{
  /** The environment and working directory this daemon runs with; nothing below reads the process's. */
  host: HostEnvironment;
  /** The resolved state-dir root; the server resolves daemon paths and passes it down. */
  baseDir: string;
  sessionsDir: string;
  /** Refuses the shutdown capability the operator denied; undefined when no policy names it. */
  assertShutdownAllowed: (() => void) | undefined;
  resolveSessionDir(sessionId: string): string;
  resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
  openWebSessionNames(): readonly string[];
}>;

/**
 * The factory that names this daemon's runtimes. The server calls it once, after resolving its
 * paths and loading the operator's policy, and before it acquires the registration; the process
 * root's implementation is `createDaemonRuntimeDeps`.
 */
export type ComposeDaemonRuntimeDeps = (
  input: DaemonRuntimeDepsInput,
) => Promise<DaemonRuntimeDeps>;
