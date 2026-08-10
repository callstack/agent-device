import crypto from 'node:crypto';
import { asAppError, AppError } from '@agent-device/kernel/errors';
import { SessionStore } from '../session-store.ts';
import { resolveDaemonPaths, resolveDaemonServerMode } from '../config.ts';
import { createDaemonHttpServer } from './http-server.ts';
import { trackDownloadableArtifact } from '../artifact-tracking.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../provider-device-runtime.ts';
import {
  createPlatformRuntimeGateway,
  createPlatformDeviceInventoryGateways,
} from '../../platform-runtime.ts';
import {
  createDefaultProviderRuntimeComposition,
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS,
} from '../../provider-device-runtimes.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { clearDaemonShutdownReport, writeDaemonShutdownReport } from '../daemon-shutdown-report.ts';
import { createRequestHandler } from '../request-router.ts';
import { stopSessionAppLog, teardownSessionResources } from '../session-teardown.ts';
import { IOS_SIMULATOR_RECORDING_STOP_ESCALATION_BUDGET_MS } from '../handlers/record-trace-ios-simulator.ts';
import { closeDaemonServers } from './server-shutdown.ts';
import type { DaemonInvokeFn, SessionState } from '../types.ts';
import { createDaemonIdleReap } from './daemon-idle-reap.ts';
import { finalizeDaemonSessionLease } from './daemon-session-lease-finalizer.ts';
import { clearAdvisoryDeviceClaim, pruneDeadDeviceClaims } from '../device-claims.ts';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '../../utils/diagnostics.ts';
import { isEnvTruthy } from '../../utils/retry.ts';
import { resetAndroidSnapshotHelperSessions } from '../../platforms/android/snapshot-helper.ts';
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
import { prewarmPngWorker, terminatePngWorker } from '../../utils/png-worker-client.ts';
import { sleep } from '../../utils/timeouts.ts';
import { setRunnerLeaseOwnerStateDir } from '../../platforms/apple/core/runner/runner-lease.ts';
import { cleanupManagedAgentBrowserOrphans } from '../../platforms/web/agent-browser-lifecycle.ts';
import { getManagedAgentBrowserStatus } from '../../platforms/web/agent-browser-tool.ts';
import { openWebSessionNames } from '../web-session-names.ts';
import {
  listAndroidAdbSerialsQuick,
  restoreOrphanedAndroidTestImeOnDaemonStartup,
} from '../../platforms/android/ime-lifecycle.ts';
import {
  recoverAppLogResourcesAfterDaemonLock,
  type AppLogRecoveryDiagnostic,
} from '../app-log-resource-recovery.ts';
import { createDaemonRecoveryPlatformScope } from '../platform-request-scope.ts';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';

const DAEMON_SESSION_TEARDOWN_TIMEOUT_MS = 5_000;
const DAEMON_SESSION_LEASE_RELEASE_TIMEOUT_MS = 1_000;
const DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DAEMON_PROVIDER_RELEASE_DRAIN_TIMEOUT_MS = 2_000;

type WritableOutput = {
  write: (chunk: string) => unknown;
};

/**
 * Per-session teardown budget for daemon shutdown. The base budget is enough
 * for ordinary resource cleanup, but a session with an active recording must be
 * allowed to run the full recorder-stop escalation (direct-handle SIGINT wait
 * plus PID-based SIGINT/SIGTERM/SIGKILL retries), which alone exceeds the base
 * budget — racing that against the base 5s would let shutdown advance to
 * process exit exactly when fallback cleanup begins, orphaning the recorder
 * with an unfinalized mp4. The recording budget EXTENDS the base one so the
 * session's remaining cleanup steps keep their usual allowance.
 */
export function resolveDaemonSessionTeardownTimeoutMs(session: SessionState): number {
  if (!session.recording) return DAEMON_SESSION_TEARDOWN_TIMEOUT_MS;
  return DAEMON_SESSION_TEARDOWN_TIMEOUT_MS + IOS_SIMULATOR_RECORDING_STOP_ESCALATION_BUDGET_MS;
}

/**
 * Daemon-shutdown teardown of one session: bounded resource cleanup (budget
 * from {@link resolveDaemonSessionTeardownTimeoutMs}, resolved BEFORE cleanup
 * starts since finalizing the recording detaches `session.recording`), then the
 * repair-commit finalization and session deletion. Cleanup failures — including
 * a recorder that could not be finalized — surface on stderr instead of being
 * silently swallowed.
 */
export async function teardownDaemonSessionForShutdown(params: {
  session: SessionState;
  sessionStore: SessionStore;
  stateDir?: string;
  stderr: WritableOutput;
  beforeDelete?: (session: SessionState) => Promise<void>;
  afterSuccessfulTeardown?: (session: SessionState) => Promise<void>;
}): Promise<void> {
  const { session, sessionStore, stateDir, stderr, beforeDelete, afterSuccessfulTeardown } = params;
  const timeoutMs = resolveDaemonSessionTeardownTimeoutMs(session);
  // The ownership-fenced app-log side effect must settle while this process
  // still owns the daemon lock. It is intentionally outside the generic
  // teardown race so lock release and runtime shutdown cannot overtake it.
  const appLogTeardownSucceeded = await stopSessionAppLog({ session, sessionStore }).then(
    () => true,
    (error) => {
      stderr.write(
        `Daemon app-log teardown error (${session.name}): ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return false;
    },
  );
  const sessionAfterAppLog = sessionStore.get(session.name) ?? session;
  const teardown = teardownSessionResources({
    appLog: 'already-settled',
    session: sessionAfterAppLog,
    sessionName: session.name,
    stateDir,
  }).then(
    () => true,
    (error) => {
      stderr.write(
        `Daemon session teardown error (${session.name}): ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      return false;
    },
  );
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
  sessionStore.delete(session.name);
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
  setRunnerLeaseOwnerStateDir(baseDir);

  const sessionStore = new SessionStore(sessionsDir);
  const appLogAdmissionLedger = createAppLogAdmissionLedger();
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
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: sessionStore.resolveAppLogPath(sessionId),
      pidPath: sessionStore.resolveAppLogPidPath(sessionId),
    }),
  });
  const providerRuntimeProviders = createProviderDeviceRuntimeRequestProviders(
    providerDeviceRuntimes,
    { providerRuntimeRequiredIds: DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS },
  );
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
  const deviceInventoryGateways = createPlatformDeviceInventoryGateways(
    providerRuntimeProviders.deviceInventorySource,
  );

  const dispatchRequest = createRequestHandler({
    logPath,
    stateDir: baseDir,
    token,
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: providerRuntimeProviders.leaseLifecycleProvider,
    cloudArtifactProvider,
    deviceInventoryGateways,
    deviceRuntimeGateway,
    appLogAdmissionLedger,
    appleRunnerProvider: providerRuntimeProviders.appleRunnerProvider,
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

  const teardownDaemonSession = async (session: SessionState): Promise<void> =>
    await teardownDaemonSessionForShutdown({
      session,
      sessionStore,
      stateDir: baseDir,
      stderr,
      beforeDelete: async (sessionToFinalize) => {
        await finalizeDaemonSessionLease({
          session: sessionToFinalize,
          leaseRegistry,
          expiredProviderLeaseReleaser,
          timeoutMs: DAEMON_SESSION_LEASE_RELEASE_TIMEOUT_MS,
        });
      },
      afterSuccessfulTeardown: async (sessionToFinalize) =>
        await clearAdvisoryDeviceClaim(sessionToFinalize.deviceClaim),
    });

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
        token,
        retainArtifacts,
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
    setRunnerLeaseOwnerStateDir(undefined);
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
    await cleanupWebBrowserOrphansForDaemonStartup({ stateDir: baseDir, sessionStore });
    // Fire-and-forget: gated on a state-dir marker so it only touches adb when a prior run here
    // actually activated the test IME (never on hosts that don't use it, e.g. the macOS runner).
    void restoreOrphanedAndroidTestImeOnDaemonStartup({
      stateDir: baseDir,
      listSerials: listAndroidAdbSerialsQuick,
    }).catch(() => {});
    const opened = await openDaemonServers();
    servers = opened.servers;
    socketPort = opened.socketPort;
    httpPort = opened.httpPort;
    publishDaemonInfo(socketPort, httpPort);
    await flushDaemonStartupDiagnostics(logPath, startupAppLogDiagnostics);
    // After publication: publishDaemonInfo truncates daemon.log, so anything
    // written before it is lost — including the prune's own diagnostic.
    await pruneDeviceClaimsForDaemonStartup(logPath);
    // Arms the initial idle-reap timer: a daemon that starts and never
    // receives a request must still be able to reap itself.
    idleReap.noteActivity();
  } catch (error) {
    const appErr = asAppError(error);
    stderr.write(`Daemon error: ${appErr.message}\n`);
    closeServersBestEffort(servers);
    removeInfo(infoPath);
    releaseDaemonLock(lockPath);
    setRunnerLeaseOwnerStateDir(undefined);
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
    // Hand healthy simulator runners off to the next daemon before session
    // teardown gets a chance to kill them; everything left after this
    // (real devices, unhealthy runners) goes through the normal stop path.
    const { detachIosSimulatorRunnerSessionsForShutdown, stopAllIosRunnerSessions } =
      await import('../../platforms/apple/core/runner/runner-client.ts');
    try {
      await detachIosSimulatorRunnerSessionsForShutdown();
    } catch {}
    expiredProviderLeaseReleaser.beginShutdown();
    await teardownDaemonSessions();
    try {
      await resetAndroidSnapshotHelperSessions();
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
    writeDaemonShutdownReport(baseDir, providerReleaseDrain);
    emitDiagnostic({
      level: providerReleaseDrain.pending.length === 0 ? 'info' : 'warn',
      phase: 'daemon_shutdown_provider_release_drain',
      data: {
        releasedLeaseIds: providerReleaseDrain.released.map((lease) => lease.leaseId),
        pendingLeaseIds: providerReleaseDrain.pending.map((lease) => lease.leaseId),
      },
    });
    expiredProviderLeaseReleaser.shutdown();
    await deviceRuntimeGateway.shutdown();
    await Promise.allSettled(
      providerDeviceRuntimes.map(async (runtime) => await runtime.shutdown()),
    );
    await stopAllIosRunnerSessions();
    // Best effort: stop the PNG worker so an in-flight job cannot delay exit.
    await Promise.race([
      terminatePngWorker().catch(() => {}),
      sleep(DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS),
    ]);
    removeInfo(infoPath);
    releaseDaemonLock(lockPath);
    setRunnerLeaseOwnerStateDir(undefined);
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

async function pruneDeviceClaimsForDaemonStartup(logPath: string): Promise<void> {
  // Startup runs outside any diagnostics scope, where emitDiagnostic is a no-op,
  // so the prune has to open one of its own for its events to be recorded.
  await withDiagnosticsScope(
    { command: 'daemon', session: 'daemon', logPath, debug: true },
    async () => {
      try {
        const { pruned } = await pruneDeadDeviceClaims();
        if (pruned > 0) {
          emitDiagnostic({ phase: 'device_claim_prune', data: { pruned } });
          flushDiagnosticsToSessionFile({ force: true });
        }
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'device_claim_prune_failed',
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
}): Promise<void> {
  const status = getManagedAgentBrowserStatus({ stateDir: params.stateDir });
  if (!status.installed) return;
  try {
    await cleanupManagedAgentBrowserOrphans(status, 'daemon-startup', {
      openWebSessionNames: openWebSessionNames(params.sessionStore),
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'web_agent_browser_orphan_cleanup_failed',
      data: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}
