// The daemon runtime's dependency construction, extracted from `src/daemon/server/daemon-runtime.ts`
// so the operational server owns sequencing and this module owns naming runtimes (ADR 0019).
// Everything here that names a platform runtime, a provider runtime, an interactor, host
// diagnostics, credential fingerprinting, resource cleanup, the platform lifecycle owners, the
// platform-services composition, or the claim-recovery gateway lives in the process root;
// `src/daemon.ts` calls `createDaemonRuntimeDeps` and hands the result to `startDaemonRuntime`.
//
// The static import set is exactly the family `daemon-runtime.ts` already evaluated eagerly, so
// the daemon entry's eager closure does not grow; the platform-services and claim-recovery
// compositions stay behind function-scoped `await import`, and the command surface loads on first
// request use. Nothing here value-imports `src/daemon/`: the daemon's session data enters through
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
import { withDaemonDiagnosticsScope } from '@agent-device/daemon-contracts/daemon-diagnostics-scope';
import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type { AgentDeviceRuntimeConfig } from '@agent-device/contracts/runtime-contract';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';
import type { DaemonRuntimeDeps } from './daemon/server/daemon-runtime.ts';

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
 * runtime used to build them. All members are required: a daemon process either receives this
 * composition or cannot start, and a test passes the same shared fixture (ADR 0019). The
 * session-scoped callbacks are the daemon's own data seen as questions — recording artifact
 * paths, session directories, and which web sessions are open — so no daemon value crosses here.
 */
export async function createDaemonRuntimeDeps(
  input: Readonly<{
    env: NodeJS.ProcessEnv;
    /** Resolved daemon paths' state-dir root; the daemon owns path resolution and passes it down. */
    baseDir: string;
    sessionsDir: string;
    /** ADR 0029: the operator's policy, loaded by the executable so a bad policy stops startup. */
    daemonPolicy: DaemonPolicy | undefined;
    /** Refuses the shutdown capability the operator denied; undefined when no policy names it. */
    assertShutdownAllowed: (() => void) | undefined;
    resolveSessionDir(sessionId: string): string;
    resolveSessionArtifacts(sessionId: string): AppLogSessionArtifacts;
    openWebSessionNames(): readonly string[];
  }>,
): Promise<DaemonRuntimeDeps> {
  const {
    env,
    baseDir,
    sessionsDir,
    daemonPolicy,
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
  const deviceInventoryGateways = createPlatformDeviceInventoryGateways(
    providerRuntimeProviders.deviceInventorySource,
  );
  // Root composition of the platform-services port and the owner-scoped claim-recovery gateway.
  // platform-runtime.ts is already static in this module, so the deferred imports keep these thin
  // composition modules (and the readiness/open-target adapters only the services module pulls)
  // off `src/daemon.ts`'s eager closure; what each adapter itself loads stays as lazy as it was.
  const { createDaemonPlatformServices } = await import('./platform-runtime-daemon-services.ts');
  const { createClaimRecoveryGateway } = await import('./platform-runtime-claim-recovery.ts');

  return Object.freeze({
    daemonPolicy,
    ownedProcessRecords,
    hostDiagnostics,
    ownerLifecycle: platformDaemonLifecycleOwners,
    providerDeviceRuntimes,
    interactorResolution: Object.freeze({ resolve: getInteractor }),
    providerDeviceAdmission: Object.freeze({
      isActive: (device: DeviceInfo) => isActiveProviderDevice(device),
    }),
    cleanupManagedWebOrphans: cleanupWebBrowserOrphansForDaemonStartup,
    notifySkippedProviderRuntimes: async (logPath: string) => {
      // Outside any request, so debug is forced on for the same reason the #2681 handoff forces
      // it — the event is the point of the record and must not be dropped by a level that was
      // never set for it.
      for (const { provider, error } of providerComposition.skipped ?? []) {
        await withDaemonDiagnosticsScope({ logPath }, () => {
          emitDiagnostic({
            level: 'warn',
            phase: 'provider_runtime_skipped',
            data: {
              provider,
              code: error.code,
              message: error.message,
              hint: error.details?.hint,
            },
          });
        });
      }
    },
    providerRuntimeProviders: Object.freeze({
      leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
      providerRuntimeIds: providerRuntimeProviders.providerRuntimeIds,
      recoverExpiredLease: providerRuntimeProviders.recoverExpiredLease,
      recoverableProviderIds: providerRuntimeProviders.recoverableProviderIds,
    }),
    requestRouter: Object.freeze({
      requestPlatformProviders,
      deviceInventoryGateways,
      deviceRuntimeGateway,
      platformServices: createDaemonPlatformServices(),
      claimRecoveryGateway: createClaimRecoveryGateway,
      androidObservation,
      platformResourceCleanup,
      providerCredentials: readDaemonProviderCredentials(env, baseDir),
      createCommandSurface: async (config: AgentDeviceRuntimeConfig) =>
        (
          await import('./command-runtime/runtime-command-surface.ts')
        ).createCommandSurfaceAgentDevice(config),
      cloudArtifactProvider: providerRuntimeProviders.cloudArtifactProvider,
      providerAppCatalog: providerRuntimeProviders.providerAppCatalog,
      leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
      providerRuntimeIds: providerRuntimeProviders.providerRuntimeIds,
      providerRuntimeRequiredIds: providerRuntimeProviders.providerRuntimeRequiredIds,
      providerDeviceRuntimeScope: providerRuntimeProviders.providerDeviceRuntimeScope,
    }),
  });
}
