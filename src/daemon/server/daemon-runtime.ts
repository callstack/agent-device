import crypto from 'node:crypto';
import { asAppError, AppError } from '@agent-device/kernel/errors';
import { resolveSessionRequestLogPath, SessionStore } from '../session-store.ts';
import { resolveDaemonPaths, resolveDaemonServerMode } from '../config.ts';
import { createDaemonHttpServer } from './http-server.ts';
import { trackDownloadableArtifact } from '../artifact-tracking.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../provider-device-runtime.ts';
import {
  androidObservation,
  createPlatformRuntimeGateway,
  createPlatformDeviceInventoryGateways,
  createRequestPlatformProviders,
} from '../../platform-runtime.ts';
import { createHostDiagnostics } from '../../platform-runtime-host-diagnostics.ts';
import {
  createDefaultProviderRuntimeComposition,
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS,
} from '../../provider-device-runtimes.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { clearDaemonShutdownReport, writeDaemonShutdownReport } from '../daemon-shutdown-report.ts';
import { createRequestHandler } from '../request-router.ts';
import { stopSessionAppLog, teardownSessionResources } from '../session-teardown.ts';
import { finalizeDaemonSessionApplicationLifecycle } from '../application-lifecycle-recovery.ts';
import { runtimeHintValues } from '../handlers/session-runtime.ts';
import { closeDaemonServers } from './server-shutdown.ts';
import type { DaemonInvokeFn, SessionState } from '../types.ts';
import { createDaemonIdleReap } from './daemon-idle-reap.ts';
import { finalizeDaemonSessionLease } from './daemon-session-lease-finalizer.ts';
import { reconcileOrphanedDeviceClaims, type DeviceClaimReconciler } from '../device-claims.ts';
import { createDeviceClaimReconciler } from '../device-claim-reconciliation.ts';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import { createPerfCaptureAdmissionLedger } from '../perf-capture-admission-ledger.ts';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import {
  createOwnedProcessRecordStore,
  type OwnedProcessRecordStore,
  reapOwnedProcessRecordsAtStartup,
} from '@agent-device/host-kit/process';
import { isEnvTruthy, sleep } from '@agent-device/host-kit/retry';

import {
  acquireDaemonLock,
  parseIntegerEnv,
  readProcessStartTime,
  readVersion,
  releaseDaemonLock,
  removeInfo,
  resolveDaemonCodeSignature,
  writeInfo,
} from './server-lifecycle.ts';
import {
  createSocketServer,
  listenHttpServer,
  listenNetServer,
  type DaemonServer,
} from './transport.ts';
import { prewarmPngWorker, terminatePngWorker } from '@agent-device/capture-kit/png-worker-client';

import { configureAppleRunnerLeaseOwnerStateDir } from '../../platform-runtime-apple-runner-owner.ts';
import {
  cleanupManagedWebRuntimeOrphans,
  platformResourceCleanup,
  resetAndroidSnapshotHelperRuntime,
} from '../../platform-runtime-resource-cleanup.ts';
import { isWebSession, openWebSessionNames } from '../web-session-names.ts';
import {
  recoverAppLogResourcesAfterDaemonLock,
  type AppLogRecoveryDiagnostic,
} from '../app-log-resource-recovery.ts';
import { createDaemonRecoveryPlatformScope } from '../platform-request-scope.ts';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { createAudioProbeAdmissionLedger } from '../audio-probe-admission-ledger.ts';
import { createScreenRecordingAdmissionLedger } from '../screen-recording-admission-ledger.ts';

const DAEMON_SESSION_TEARDOWN_TIMEOUT_MS = 5_000;
export const SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS = 11_000;
// Mirrors AGENT_BROWSER_TIMEOUT_MS in @agent-device/platform-web: the ceiling that
// module already places on one `agent-browser` CLI call, so the race below never gives up on the
// web-close step while the close it started is still running within its own enforced limit.
export const WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS = 30_000;
const DAEMON_SESSION_LEASE_RELEASE_TIMEOUT_MS = 1_000;
const DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DAEMON_PROVIDER_RELEASE_DRAIN_TIMEOUT_MS = 2_000;

type WritableOutput = {
  write: (chunk: string) => unknown;
};

/**
 * Per-session teardown budget for daemon shutdown. The base budget covers ordinary resources; an
 * active durable recording or an open web session gets an additional owner-finalization budget so
 * the daemon cannot exit while its runtime handle is still producing the terminal media artifact,
 * or while agent-browser is still closing its Chrome fleet. The base portion remains available to
 * cleanup steps that follow recording finalization or the web close.
 */
export function resolveDaemonSessionTeardownTimeoutMs(session: SessionState): number {
  let timeoutMs = DAEMON_SESSION_TEARDOWN_TIMEOUT_MS;
  if (session.screenRecording) timeoutMs += SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS;
  if (isWebSession(session)) timeoutMs += WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS;
  return timeoutMs;
}

async function settleDaemonTeardownStep(params: {
  session: SessionState;
  stderr: WritableOutput;
  resource: 'app-log' | 'session' | 'lifecycle';
  teardown: () => Promise<unknown>;
}): Promise<boolean> {
  const { session, stderr, resource, teardown } = params;
  try {
    await teardown();
    return true;
  } catch (error) {
    stderr.write(
      `Daemon ${resource} teardown error (${session.name}): ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return false;
  }
}

/**
 * Daemon-shutdown teardown of one session: bounded resource cleanup (budget
 * from {@link resolveDaemonSessionTeardownTimeoutMs}, resolved BEFORE cleanup
 * starts since finalizing the recording detaches `session.screenRecording`), then the
 * repair-commit finalization and session deletion. Cleanup failures — including
 * a recorder that could not be finalized — surface on stderr instead of being
 * silently swallowed.
 */
export async function teardownDaemonSessionForShutdown(params: {
  session: SessionState;
  sessionStore: SessionStore;
  stateDir?: string;
  stderr: WritableOutput;
  finalizeApplicationLifecycle?: (session: SessionState) => Promise<void>;
  beforeDelete?: (session: SessionState) => Promise<void>;
  afterSuccessfulTeardown?: (session: SessionState) => Promise<void>;
}): Promise<void> {
  const {
    session,
    sessionStore,
    stateDir,
    stderr,
    finalizeApplicationLifecycle,
    beforeDelete,
    afterSuccessfulTeardown,
  } = params;
  const sessionName = sessionStore.resolveStoredSessionName(session);
  const timeoutMs = resolveDaemonSessionTeardownTimeoutMs(session);
  // The ownership-fenced app-log side effect must settle while this process
  // still owns the daemon lock. It is intentionally outside the generic
  // teardown race so lock release and runtime shutdown cannot overtake it.

  const appLogTeardownSucceeded = await settleDaemonTeardownStep({
    session,
    stderr,
    resource: 'app-log',
    teardown: async () => await stopSessionAppLog({ session, sessionName, sessionStore }),
  });
  const sessionAfterAppLog = sessionStore.get(sessionName) ?? session;
  const teardown = (async () => {
    const genericTeardownSucceeded = await settleDaemonTeardownStep({
      session,
      stderr,
      resource: 'session',
      teardown: async () =>
        await teardownSessionResources({
          appLog: 'already-settled',
          session: sessionAfterAppLog,
          sessionName,
          sessionStore,
          stateDir,
          platformCleanup: platformResourceCleanup,
        }),
    });
    const lifecycleTeardownSucceeded = finalizeApplicationLifecycle
      ? await settleDaemonTeardownStep({
          session,
          stderr,
          resource: 'lifecycle',
          teardown: async () => await finalizeApplicationLifecycle(sessionAfterAppLog),
        })
      : true;
    return genericTeardownSucceeded && lifecycleTeardownSucceeded;
  })();
  const genericTeardownSucceeded = await Promise.race([
    teardown,
    sleep(timeoutMs).then(() => {
      stderr.write(`Daemon session teardown timed out (${session.name}).\n`);
      return false;
    }),
  ]);
  const teardownSucceeded = appLogTeardownSucceeded && genericTeardownSucceeded;
  // ADR 0012 decision 6, R7 + commit semantics (C2/C5a): commit the healed
  // `.ad` iff the repair transaction completed, else leave a bounded
  // `REPAIR_SESSION_EXPIRED` tombstone for the reaped-before-finalize case.
  sessionStore.finalizeRepairTeardown(session);
  await beforeDelete?.(session);
  if (teardownSucceeded) await afterSuccessfulTeardown?.(session);
  sessionStore.delete(sessionName);
}

export type DaemonRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  stdout?: WritableOutput;
  stderr?: WritableOutput;
  exit?: (code: number) => void;
  registerProcessHandlers?: boolean;
};

export type DaemonRuntimeController = {
  httpPort?: number;
  socketPort?: number;
  shutdown: (options?: { exitCode?: number; cause?: unknown }) => Promise<void>;
  token: string;
};

export async function flushDaemonStartupDiagnostics(
  logPath: string,
  diagnostics: readonly AppLogRecoveryDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  await withDiagnosticsScope(
    { command: 'daemon-startup', session: 'daemon', logPath, debug: false },
    async () => {
      for (const diagnostic of diagnostics) {
        emitDiagnostic({
          level: 'warn',
          phase: diagnostic.phase,
          data: { resourcePath: diagnostic.resourcePath, ...diagnostic.data },
        });
      }
      flushDiagnosticsToSessionFile({ force: true });
    },
  );
}

export async function startDaemonRuntime(
  options: DaemonRuntimeOptions = {},
): Promise<DaemonRuntimeController | null> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const daemonPaths = resolveDaemonPaths(env.AGENT_DEVICE_STATE_DIR);
  const { baseDir, infoPath, lockPath, logPath, sessionsDir } = daemonPaths;
  const daemonServerMode = resolveDaemonServerMode(env.AGENT_DEVICE_DAEMON_SERVER_MODE);
  const retainArtifacts = isEnvTruthy(env.AGENT_DEVICE_RETAIN_ARTIFACTS);
  await configureAppleRunnerLeaseOwnerStateDir(baseDir);

  const sessionStore = new SessionStore(sessionsDir);
  const ownedProcessRecords = createOwnedProcessRecordStore({
    stateDir: baseDir,
    sessionsDir,
    resolveSessionDir: (sessionId) => sessionStore.resolveSessionDir(sessionId),
  });
  const appLogAdmissionLedger = createAppLogAdmissionLedger();
  const audioProbeAdmissionLedger = createAudioProbeAdmissionLedger();
  const perfCaptureAdmissionLedger = createPerfCaptureAdmissionLedger();
  const hostDiagnostics = createHostDiagnostics();
  const screenRecordingAdmissionLedger = createScreenRecordingAdmissionLedger();
  const version = readVersion();
  const token = crypto.randomBytes(24).toString('hex');
  const daemonProcessStartTime = readProcessStartTime(process.pid) ?? undefined;
  const daemonCodeSignature = resolveDaemonCodeSignature();
  const providerComposition = await createDefaultProviderRuntimeComposition(env);
  const providerDeviceRuntimes = [...providerComposition.runtimes];
  const deviceRuntimeGateway = createPlatformRuntimeGateway({
    providerRuntimes: providerDeviceRuntimes,
    providerModules: providerComposition.platformModules,
    sessionsDir,
    ownedProcesses: ownedProcessRecords,
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: sessionStore.resolveAppLogPath(sessionId),
      pidPath: sessionStore.resolveAppLogPidPath(sessionId),
    }),
  });
  const applicationLifecycle = deviceRuntimeGateway.applicationLifecycle;
  if (!applicationLifecycle) {
    throw new AppError('COMMAND_FAILED', 'Platform lifecycle gateway is not configured.', {
      reason: 'runtime-gateway-missing',
    });
  }
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
      openWebSessionNames: () => openWebSessionNames(sessionStore),
      ownedProcessRecords,
    },
  });
  const expiredProviderLeaseReleaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
    providerRuntimeIds: providerRuntimeProviders.providerRuntimeIds,
    recoverExpiredLease: providerRuntimeProviders.recoverExpiredLease,
    stateDir: baseDir,
    recoverableProviderIds: providerRuntimeProviders.recoverableProviderIds,
  });
  void expiredProviderLeaseReleaser.retryPending();
  const leaseRegistry = new LeaseRegistry({
    maxActiveSimulatorLeases: parseIntegerEnv(env.AGENT_DEVICE_MAX_SIMULATOR_LEASES),
    defaultLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_TTL_MS),
    minLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_MIN_TTL_MS),
    maxLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_MAX_TTL_MS),
    onLeaseExpired: (lease) => {
      void expiredProviderLeaseReleaser.release(lease);
    },
  });
  const cloudArtifactProvider = providerRuntimeProviders.cloudArtifactProvider;
  const providerAppCatalog = providerRuntimeProviders.providerAppCatalog;
  const deviceInventoryGateways = createPlatformDeviceInventoryGateways(
    providerRuntimeProviders.deviceInventorySource,
  );

  const dispatchRequest = createRequestHandler({
    logPath,
    token,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
    cloudArtifactProvider,
    providerAppCatalog,
    deviceInventoryGateways,
    deviceRuntimeGateway,
    appLogAdmissionLedger,
    audioProbeAdmissionLedger,
    perfCaptureAdmissionLedger,
    hostDiagnostics,
    screenRecordingAdmissionLedger,
    requestPlatformProviders,
    androidObservation,
    platformResourceCleanup,
    providerRuntimeIds: providerRuntimeProviders.providerRuntimeIds,
    providerRuntimeRequiredIds: providerRuntimeProviders.providerRuntimeRequiredIds,
    providerDeviceRuntimeScope: providerRuntimeProviders.providerDeviceRuntimeScope,
    trackDownloadableArtifact,
  });

  const emitFatalDiagnostic = async (error: unknown): Promise<void> => {
    await withDiagnosticsScope(
      { command: 'daemon', session: 'daemon', logPath, debug: true },
      async () => {
        emitDiagnostic({
          level: 'error',
          phase: 'daemon_fatal',
          data: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
        flushDiagnosticsToSessionFile({ force: true });
      },
    );
  };

  const shutdownClaimLedger = createDaemonShutdownClaimLedger();

  const teardownDaemonSession = async (session: SessionState): Promise<void> => {
    try {
      await teardownDaemonSessionForShutdown({
        session,
        sessionStore,
        stderr,
        finalizeApplicationLifecycle: async (sessionToFinalize) =>
          await finalizeDaemonSessionApplicationLifecycle({
            gateway: deviceRuntimeGateway,
            scope: createDaemonRecoveryPlatformScope(),
            session: sessionToFinalize,
            stateDir: baseDir,
            runtimeHints: runtimeHintValues(sessionStore.getRuntimeHints(sessionToFinalize.name)),
          }),
        beforeDelete: async (sessionToFinalize) => {
          await finalizeDaemonSessionLease({
            session: sessionToFinalize,
            leaseRegistry,
            expiredProviderLeaseReleaser,
            timeoutMs: DAEMON_SESSION_LEASE_RELEASE_TIMEOUT_MS,
          });
        },
        afterSuccessfulTeardown: shutdownClaimLedger.releaseClaim,
      });
    } finally {
      shutdownClaimLedger.finalize(session);
    }
  };

  const teardownDaemonSessions = async (): Promise<void> => {
    const sessionsToStop = sessionStore.toArray();
    await Promise.all(sessionsToStop.map(teardownDaemonSession));
  };

  // Reaps this daemon process when it sits fully idle (no open sessions, no
  // in-flight requests, no active recording) past AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS.
  // `shutdown` is defined below but only invoked asynchronously by the timer,
  // well after this closure captures it.
  let inFlightRequestCount = 0;
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => inFlightRequestCount,
    onIdleReap: () => {
      void shutdown();
    },
    env,
  });

  const handleRequest: DaemonInvokeFn = async (req) => {
    inFlightRequestCount++;
    idleReap.cancel();
    try {
      return await dispatchRequest(req);
    } finally {
      inFlightRequestCount--;
      idleReap.noteActivity();
    }
  };

  const openDaemonServers = async (): Promise<{
    servers: DaemonServer[];
    socketPort?: number;
    httpPort?: number;
  }> => {
    const servers: DaemonServer[] = [];
    let socketPort: number | undefined;
    let httpPort: number | undefined;
    const startSocketServer = daemonServerMode !== 'http';
    const startHttpServer = daemonServerMode !== 'socket';
    if (startSocketServer) {
      const socketServer = createSocketServer(handleRequest);
      servers.push(socketServer);
      socketPort = await listenNetServer(socketServer);
    }

    if (startHttpServer) {
      const httpServer = await createDaemonHttpServer({
        handleRequest,
        leaseRegistry,
        token,
        retainArtifacts,
        env,
        // #1801: the same record `DaemonError.logPath` names, addressed by its
        // locator so a remote caller can fetch what it cannot read by path.
        resolveRequestDiagnosticsPath: (ref) =>
          resolveSessionRequestLogPath(sessionStore.resolveSessionDir(ref.session), ref.requestId),
      });
      servers.push(httpServer);
      httpPort = await listenHttpServer(httpServer);
    }
    return { servers, socketPort, httpPort };
  };

  const publishDaemonInfo = (socketPort: number | undefined, httpPort: number | undefined) => {
    writeInfo(baseDir, infoPath, logPath, {
      socketPort,
      httpPort,
      token,
      version,
      codeSignature: daemonCodeSignature,
      processStartTime: daemonProcessStartTime,
    });
    if (socketPort) stdout.write(`AGENT_DEVICE_DAEMON_PORT=${socketPort}\n`);
    if (httpPort) stdout.write(`AGENT_DEVICE_DAEMON_HTTP_PORT=${httpPort}\n`);
  };

  const closeServersBestEffort = (servers: DaemonServer[]): void => {
    for (const server of servers) {
      try {
        server.close(() => {});
      } catch {}
    }
  };

  const lockData = {
    pid: process.pid,
    version,
    startedAt: Date.now(),
    processStartTime: daemonProcessStartTime,
  };
  if (!acquireDaemonLock(baseDir, lockPath, lockData)) {
    stderr.write('Daemon lock is held by another process; exiting.\n');
    await configureAppleRunnerLeaseOwnerStateDir(undefined);
    exit(0);
    return null;
  }
  clearDaemonShutdownReport(baseDir);

  let servers: DaemonServer[] = [];
  let socketPort: number | undefined;
  let httpPort: number | undefined;
  const startupAppLogDiagnostics: AppLogRecoveryDiagnostic[] = [];
  try {
    const { recoverLegacyAppLogMarkersAfterDaemonLock } =
      await import('../../platform-runtime-operation-host.ts');
    const legacyMarkerRecovery = await recoverLegacyAppLogMarkersAfterDaemonLock(sessionsDir);
    appLogAdmissionLedger.retainLegacyMarkers(legacyMarkerRecovery.retained);
    for (const markerPath of legacyMarkerRecovery.recovered) {
      startupAppLogDiagnostics.push({
        phase: 'app_log_legacy_marker_recovered',
        resourcePath: markerPath,
        data: {},
      });
    }
    for (const retained of legacyMarkerRecovery.retained) {
      startupAppLogDiagnostics.push({
        phase: 'app_log_legacy_marker_retained',
        resourcePath: retained.markerPath,
        data: {
          reason: retained.reason,
          ...(retained.message === undefined ? {} : { message: retained.message }),
        },
      });
    }
    await recoverAppLogResourcesAfterDaemonLock({
      sessionsDir,
      gateway: deviceRuntimeGateway,
      scope: createDaemonRecoveryPlatformScope(),
      onDiagnostic: (diagnostic) => startupAppLogDiagnostics.push(diagnostic),
    });
    await reapOwnedProcessRecordsAtStartup(ownedProcessRecords, {
      openWebSessionNames: openWebSessionNames(sessionStore),
      purposes: ['simctl-screen-recording'],
    });
    await cleanupWebBrowserOrphansForDaemonStartup({
      stateDir: baseDir,
      sessionStore,
      ownedProcessRecords,
    });
    // Marker-gated lifecycle recovery owns test-IME orphan repair. Its implementation remains
    // lazy until the marker exists, so a normal daemon startup does not load or probe adb.
    void applicationLifecycle.recoverStartupResources({ stateDir: baseDir }).catch((error) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_lifecycle_startup_recovery_failed',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    });
    const opened = await openDaemonServers();
    servers = opened.servers;
    socketPort = opened.socketPort;
    httpPort = opened.httpPort;
    publishDaemonInfo(socketPort, httpPort);
    await flushDaemonStartupDiagnostics(logPath, startupAppLogDiagnostics);
    // After publication: publishDaemonInfo truncates daemon.log, so anything
    // written before it is lost — including reconciliation diagnostics.
    await reconcileDeviceClaimsForDaemonStartup(
      logPath,
      createDeviceClaimReconciler({
        gateway: deviceRuntimeGateway,
        scope: createDaemonRecoveryPlatformScope(),
      }),
      baseDir,
    );
    // Arms the initial idle-reap timer: a daemon that starts and never
    // receives a request must still be able to reap itself.
    idleReap.noteActivity();
  } catch (error) {
    const appErr = asAppError(error);
    stderr.write(`Daemon error: ${appErr.message}\n`);
    closeServersBestEffort(servers);
    removeInfo(infoPath);
    releaseDaemonLock(lockPath);
    await configureAppleRunnerLeaseOwnerStateDir(undefined);
    exit(1);
    return null;
  }

  // Spawn the PNG worker ahead of the first screenshot request so its
  // cold-start cost is not paid on a user-visible call. Best effort: when it
  // cannot start, PNG processing falls back to the in-process sync path.
  prewarmPngWorker();

  let shuttingDown = false;
  const shutdown = async (shutdownOptions: { exitCode?: number; cause?: unknown } = {}) => {
    idleReap.cancel();
    if (shuttingDown) return;
    shuttingDown = true;
    if (shutdownOptions.cause) {
      await emitFatalDiagnostic(shutdownOptions.cause);
    }
    await closeDaemonServers(servers);
    // Hand healthy simulator runners off before durable session teardown. The lifecycle gateway
    // later terminates only still-owned generations once all resources have finalized.
    try {
      await applicationLifecycle.detachForDaemonShutdown();
    } catch {}
    expiredProviderLeaseReleaser.beginShutdown();
    await teardownDaemonSessions();
    try {
      await resetAndroidSnapshotHelperRuntime();
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'daemon_shutdown_android_snapshot_helper_cleanup_failed',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    const providerReleaseDrain = await expiredProviderLeaseReleaser.drain(
      DAEMON_PROVIDER_RELEASE_DRAIN_TIMEOUT_MS,
    );
    writeDaemonShutdownReport(baseDir, {
      providerReleases: providerReleaseDrain,
      claims: shutdownClaimLedger.claims,
    });
    emitDiagnostic({
      level: providerReleaseDrain.pending.length === 0 ? 'info' : 'warn',
      phase: 'daemon_shutdown_provider_release_drain',
      data: {
        releasedLeaseIds: providerReleaseDrain.released.map((lease) => lease.leaseId),
        pendingLeaseIds: providerReleaseDrain.pending.map((lease) => lease.leaseId),
        releasedDeviceKeys: shutdownClaimLedger.claims.released.map((claim) => claim.deviceKey),
        orphanedDeviceKeys: shutdownClaimLedger.claims.orphaned.map((claim) => claim.deviceKey),
      },
    });
    expiredProviderLeaseReleaser.shutdown();
    await deviceRuntimeGateway.shutdown();
    await Promise.allSettled(
      providerDeviceRuntimes.map(async (runtime) => await runtime.shutdown()),
    );
    await applicationLifecycle.finalizeDaemonShutdown();
    // Best effort: stop the PNG worker so an in-flight job cannot delay exit.
    await Promise.race([
      terminatePngWorker().catch(() => {}),
      sleep(DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS),
    ]);
    removeInfo(infoPath);
    releaseDaemonLock(lockPath);
    await configureAppleRunnerLeaseOwnerStateDir(undefined);
    exit(shutdownOptions.exitCode ?? 0);
  };

  if (options.registerProcessHandlers !== false) {
    process.on('SIGINT', () => {
      void shutdown();
    });
    process.on('SIGTERM', () => {
      void shutdown();
    });
    process.on('SIGHUP', () => {
      void shutdown();
    });
    process.on('uncaughtException', (err) => {
      const appErr = err instanceof AppError ? err : asAppError(err);
      stderr.write(`Daemon error: ${appErr.message}\n`);
      void shutdown({ exitCode: 1, cause: err });
    });
    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      const appErr = err instanceof AppError ? err : asAppError(err);
      stderr.write(`Daemon error: ${appErr.message}\n`);
      void shutdown({ exitCode: 1, cause: err });
    });
  }

  return {
    httpPort,
    shutdown,
    socketPort,
    token,
  };
}

async function reconcileDeviceClaimsForDaemonStartup(
  logPath: string,
  reconcile: DeviceClaimReconciler,
  stateDir: string,
): Promise<void> {
  // Startup runs outside any diagnostics scope, where emitDiagnostic is a no-op,
  // so reconciliation has to open one of its own for its events to be recorded.
  await withDiagnosticsScope(
    { command: 'daemon', session: 'daemon', logPath, debug: true },
    async () => {
      try {
        const summary = await reconcileOrphanedDeviceClaims(reconcile, stateDir);
        if (summary.examined > 0) {
          emitDiagnostic({ phase: 'device_claim_reconcile', data: summary });
          flushDiagnosticsToSessionFile({ force: true });
        }
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'device_claim_reconcile_failed',
          data: { error: error instanceof Error ? error.message : String(error) },
        });
        flushDiagnosticsToSessionFile({ force: true });
      }
    },
  );
}

export async function cleanupWebBrowserOrphansForDaemonStartup(params: {
  stateDir: string;
  sessionStore: SessionStore;
  ownedProcessRecords?: OwnedProcessRecordStore;
}): Promise<void> {
  try {
    await cleanupManagedWebRuntimeOrphans({
      stateDir: params.stateDir,
      openWebSessionNames: openWebSessionNames(params.sessionStore),
      ...(params.ownedProcessRecords === undefined
        ? {}
        : { ownedProcessRecords: params.ownedProcessRecords }),
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_orphan_cleanup_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
