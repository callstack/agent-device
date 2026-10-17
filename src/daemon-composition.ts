// The daemon runtime's dependency construction, extracted from `packages/daemon/src/server/http/daemon-runtime.ts`
// so the operational server owns sequencing and this module owns naming runtimes (ADR 0019).
// Everything here that names a platform runtime, a provider runtime, an interactor, host
// diagnostics, credential fingerprinting, resource cleanup, the platform lifecycle owners, the
// platform-services composition, or the claim-recovery gateway lives in the process root; the
// server calls `createDaemonRuntimeDeps` as a factory once it owns its paths, policy, and session
// store, so exactly one assembly builds the SessionStore and deps pair.
//
// The static import set is the family the operational server already evaluated eagerly, and the
// entry reaches this module through a function-scoped `await import`, so the daemon entry's eager
// closure does not grow; the platform-services and claim-recovery
// compositions stay behind function-scoped `await import`, and the command surface loads on first
// request use. Nothing here value-imports `packages/daemon/src/`: the daemon's session data enters through
// plain callbacks, so the platform-runtime zone keeps its value-free direction toward the daemon.

import {
  createProviderDeviceRuntimeRequestProviders,
  isActiveProviderDevice,
} from './provider-device-runtime.ts';
import {
  createDaemonProviderRuntimeComposition,
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS,
} from './provider-device-runtimes.ts';
import { readDaemonProviderCredentials } from './provider-credential-fingerprint.ts';
import { getInteractor } from './core/interactors.ts';
import {
  androidObservation,
  createPlatformRuntimeGateway,
  createPlatformDeviceInventoryGateways,
  createRequestPlatformProviders,
} from './platform-runtime.ts';
import { createHostDiagnostics } from './platform-runtime-host-diagnostics.ts';
import { platformResourceCleanup } from './platform-runtime-resource-cleanup.ts';
import { platformDaemonLifecycleOwners } from './platform-runtime-daemon-lifecycle.ts';
import {
  createOwnedProcessRecordStore,
  type OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { ComposeDaemonRuntimeDeps, DaemonRuntimeDeps } from '@agent-device/daemon';

/**
 * Best-effort startup cleanup of managed-agent-browser orphans left by a previous daemon. It runs
 * only after this process holds the daemon lock, and it never fails startup: a cleanup the host
 * refuses is a diagnostic, not a reason to keep the next daemon from serving.
 */
export async function cleanupWebBrowserOrphansForDaemonStartup(params: {
  stateDir: string;
  openWebSessionNames: readonly string[];
  ownedProcessRecords?: OwnedProcessRecordStore;
}): Promise<void> {
  try {
    await platformDaemonLifecycleOwners.cleanupManagedWebOrphans(params);
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_orphan_cleanup_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Builds every capability the daemon runtime cannot construct for itself, in the order the
 * runtime used to build them. The server calls it as a factory with the paths, the operator's
 * policy, and the session-store callbacks it owns; all returned members are required, so a
 * daemon process either receives this composition or cannot start, and a test passes the same
 * factory (ADR 0019). The session-scoped callbacks are the daemon's own data seen as questions —
 * recording artifact paths, session directories, and which web sessions are open — so no daemon
 * value crosses here.
 */
export const createDaemonRuntimeDeps: ComposeDaemonRuntimeDeps = async (
  input,
): Promise<DaemonRuntimeDeps> => {
  const {
    env,
    baseDir,
    sessionsDir,
    assertShutdownAllowed,
    resolveSessionDir,
    resolveSessionArtifacts,
    openWebSessionNames,
  } = input;
  const ownedProcessRecords = createOwnedProcessRecordStore({
    stateDir: baseDir,
    sessionsDir,
    resolveSessionDir,
  });
  const hostDiagnostics = createHostDiagnostics();
  const providerComposition = await createDaemonProviderRuntimeComposition(env);
  const providerDeviceRuntimes = [...providerComposition.runtimes];
  const deviceRuntimeGateway = createPlatformRuntimeGateway({
    assertShutdownAllowed,
    providerRuntimes: providerDeviceRuntimes,
    providerModules: providerComposition.platformModules,
    sessionsDir,
    ownedProcesses: ownedProcessRecords,
    resolveSessionArtifacts,
  });
  const providerRuntimeProviders = createProviderDeviceRuntimeRequestProviders(
    providerDeviceRuntimes,
    { providerRuntimeRequiredIds: DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS },
  );
  const requestPlatformProviders = createRequestPlatformProviders({
    providers: {
      appleRunnerProvider: providerRuntimeProviders.appleRunnerProvider,
      appleRunnerScreenRecordingTransport:
        providerRuntimeProviders.appleRunnerScreenRecordingTransport,
    },
    defaultWebProvider: {
      stateDir: baseDir,
      openWebSessionNames,
      ownedProcessRecords,
    },
  });
  const deviceInventoryGateways = await createPlatformDeviceInventoryGateways(
    providerRuntimeProviders.deviceInventorySource,
  );
  // Root composition of the platform-services port and the owner-scoped claim-recovery gateway.
  // platform-runtime.ts is already static in this module, so the deferred imports keep these thin
  // composition modules (and the readiness/open-target adapters only the services module pulls)
  // off `src/daemon.ts`'s eager closure; what each adapter itself loads stays as lazy as it was.
  const { createDaemonPlatformServices } = await import('./platform-runtime-daemon-services.ts');
  const { createClaimRecoveryGateway } = await import('./platform-runtime-claim-recovery.ts');

  return Object.freeze({
    ownedProcessRecords,
    hostDiagnostics,
    ownerLifecycle: platformDaemonLifecycleOwners,
    providerDeviceRuntimes,
    skippedProviderRuntimes: Object.freeze([...(providerComposition.skipped ?? [])]),
    leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
    providerRuntimeIds: providerRuntimeProviders.providerRuntimeIds,
    recoverExpiredLease: providerRuntimeProviders.recoverExpiredLease,
    recoverableProviderIds: providerRuntimeProviders.recoverableProviderIds,
    deviceRuntimeGateway,
    platformResourceCleanup,
    claimRecoveryGateway: createClaimRecoveryGateway,
    interactorResolution: Object.freeze({ resolve: getInteractor }),
    providerDeviceAdmission: Object.freeze({
      isActive: (device: DeviceInfo) => isActiveProviderDevice(device),
    }),
    cleanupManagedWebOrphans: cleanupWebBrowserOrphansForDaemonStartup,
    requestRouter: Object.freeze({
      requestPlatformProviders,
      deviceInventoryGateways,
      platformServices: createDaemonPlatformServices(),
      androidObservation,
      providerCredentials: readDaemonProviderCredentials(env, baseDir),
      createCommandSurface: async (config: AgentDeviceRuntimeConfig) =>
        (
          await import('./command-runtime/runtime-command-surface.ts')
        ).createCommandSurfaceAgentDevice(config),
      cloudArtifactProvider: providerRuntimeProviders.cloudArtifactProvider,
      providerAppCatalog: providerRuntimeProviders.providerAppCatalog,
      providerDeviceRuntimeScope: providerRuntimeProviders.providerDeviceRuntimeScope,
    }),
  });
};
