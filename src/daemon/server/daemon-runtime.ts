import crypto from 'node:crypto';
import { asAppError, AppError, normalizeError } from '@agent-device/kernel/errors';
import { SessionStore } from '../session-store.ts';
import { resolveSessionRequestLogPath } from '../session-artifact-paths.ts';
import { resolveDaemonPaths, resolveDaemonServerMode } from '../../daemon-resolution.ts';
import { createDaemonHttpServer } from './http-server.ts';
import { trackDownloadableArtifact } from '../artifact-tracking.ts';
import {
  createProviderDeviceRuntimeRequestProviders,
  isActiveProviderDevice,
} from '../../provider-device-runtime.ts';
import { installProviderDeviceAdmission } from '../provider-device-admission.ts';
import { assertDaemonPolicyAllowsCapability } from '../daemon-policy.ts';
import { loadDaemonPolicy, type DaemonPolicy } from '../../daemon-policy-file.ts';
import { getInteractor } from '../../core/interactors.ts';
import { installInteractorResolution } from '../interactor-resolution.ts';
import {
  androidObservation,
  createPlatformRuntimeGateway,
  createPlatformDeviceInventoryGateways,
  createRequestPlatformProviders,
} from '../../platform-runtime.ts';
import { createHostDiagnostics } from '../../platform-runtime-host-diagnostics.ts';
import {
  createDaemonProviderRuntimeComposition,
  DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS,
} from '../../provider-device-runtimes.ts';
import { readDaemonProviderCredentials } from '../../provider-credential-fingerprint.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { createRequestHandler } from '../request-router.ts';
import { getLeaseRegistryExecutionLocks } from '../request-execution-scope.ts';
import { stopSessionAppLog, teardownSessionResources } from '../session-teardown.ts';
import { resolveDaemonSessionTeardownTimeoutMs } from '../session-teardown-budget.ts';
import { finalizeDaemonSessionApplicationLifecycle } from '../application-lifecycle-recovery.ts';
import { runtimeHintValues } from '../session-runtime.ts';
import { closeDaemonServers } from './server-shutdown.ts';
import type { DaemonInvokeFn } from '../daemon-request.ts';
import type { SessionRef, SessionState } from '../session-state.ts';
import type { RuntimeHintValues } from '@agent-device/contracts/application-lifecycle-runtime';
import { createDaemonIdleReap } from './daemon-idle-reap.ts';
import { withDaemonDiagnosticsScope } from '../../daemon-diagnostics-scope.ts';
import { createSessionIdleExpiry } from './daemon-session-idle-expiry.ts';
import { resolveSessionIdleExpiryMs } from '../session-idle-expiry.ts';
import { finalizeDaemonLeases } from './daemon-lease-finalizer.ts';
import {
  processOwnsActiveDeviceClaim,
  reconcileOrphanedDeviceClaims,
  type DeviceClaimReconciler,
} from '../device/device-claims.ts';
import { createOwnerScopedDeviceClaimReconciler } from '../device/device-claim-owner-recovery.ts';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import { createAudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import { createPerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { emitDiagnostic, type ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  createOwnedProcessRecordStore,
  type OwnedProcessRecordStore,
  readCurrentOwnerIdentity,
  reapOwnedProcessRecordsAtStartup,
  type OwnerIdentity,
} from '@agent-device/host-kit/process';
import { isEnvTruthy, sleep } from '@agent-device/host-kit/retry';

import {
  parseIntegerEnv,
  readVersion,
  resolveDaemonCodeOrigin,
  resolveDaemonCodeSignature,
} from './server-lifecycle.ts';
import {
  tryAcquireDaemonRegistration,
  DAEMON_STARTUP_EXIT_CODES,
  type DaemonRegistrationOwner,
} from '../../daemon-registration-owner.ts';
import { watchDaemonMetadataLoss, type DaemonMetadataLoss } from './daemon-metadata-loss.ts';
import {
  createSocketServer,
  listenHttpServer,
  listenNetServer,
  type DaemonServer,
} from './transport.ts';
import { prewarmPngWorker, terminatePngWorker } from '@agent-device/capture-kit/png-worker-client';

import { platformResourceCleanup } from '../../platform-runtime-resource-cleanup.ts';
import { platformDaemonLifecycleOwners } from '../../platform-runtime-daemon-lifecycle.ts';
import { openWebSessionNames } from '../web-session-names.ts';
import { recoverAppLogResourcesAfterDaemonLock } from '../app-log-resource-recovery.ts';
import { createDaemonRecoveryPlatformScope } from '../platform-request-scope.ts';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';

const DAEMON_LEASE_RELEASE_TIMEOUT_MS = 1_000;
const DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DAEMON_PROVIDER_RELEASE_DRAIN_TIMEOUT_MS = 2_000;
// An orphaned `simctl recordVideo` releases the host-wide recording lock only after it finishes
// finalizing on SIGINT; force-killing it sooner leaves every later recording failing with EBUSY
// (#2170). Bound the grace to the recorder purpose, so daemon startup stays under the client budget.
const DAEMON_RECORDING_REAP_TERM_TIMEOUT_MS = 5_000;

type WritableOutput = {
  write: (chunk: string) => unknown;
};

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
  ref: SessionRef;
  sessionStore: SessionStore;
  stateDir?: string;
  stderr: WritableOutput;
  finalizeApplicationLifecycle?: (
    session: SessionState,
    runtimeHints: RuntimeHintValues,
  ) => Promise<void>;
  afterSuccessfulTeardown?: (session: SessionState) => Promise<void>;
}): Promise<void> {
  const {
    ref,
    sessionStore,
    stateDir,
    stderr,
    finalizeApplicationLifecycle,
    afterSuccessfulTeardown,
  } = params;
  const current = sessionStore.resolveCurrent(ref);
  const session = current ?? ref.session;
  const runtimeHints = runtimeHintValues(
    current ? sessionStore.getRuntimeHints(ref.address) : undefined,
  );
  const timeoutMs = resolveDaemonSessionTeardownTimeoutMs(session);
  // The ownership-fenced app-log side effect must settle while this process
  // still owns the daemon lock. It is intentionally outside the generic
  // teardown race so lock release and runtime shutdown cannot overtake it.

  const appLogTeardownSucceeded = await settleDaemonTeardownStep({
    session,
    stderr,
    resource: 'app-log',
    teardown: async () => await stopSessionAppLog({ ref, sessionStore }),
  });
  const sessionAfterAppLog = sessionStore.resolveCurrent(ref) ?? session;
  const teardown = (async () => {
    const genericTeardownSucceeded = await settleDaemonTeardownStep({
      session,
      stderr,
      resource: 'session',
      teardown: async () =>
        await teardownSessionResources({
          appLog: 'already-settled',
          ref,
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
          teardown: async () =>
            await finalizeApplicationLifecycle(sessionAfterAppLog, runtimeHints),
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
  sessionStore.finalizeRepairTeardown(ref);
  if (teardownSucceeded) await afterSuccessfulTeardown?.(session);
  sessionStore.retire(ref);
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
  diagnostics: readonly ResourceDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  await withDaemonDiagnosticsScope({ logPath, command: 'daemon-startup', debug: false }, () => {
    for (const diagnostic of diagnostics) {
      emitDiagnostic({
        level: 'warn',
        phase: diagnostic.phase,
        data: { resourcePath: diagnostic.resourcePath, ...diagnostic.data },
      });
    }
  });
}

async function noteSkippedProviderRuntimes(
  logPath: string,
  skipped: readonly Readonly<{ provider: string; error: AppError }>[] | undefined,
): Promise<void> {
  for (const { provider, error } of skipped ?? []) {
    await emitDaemonDiagnostic(logPath, 'provider_runtime_skipped', {
      provider,
      code: error.code,
      message: error.message,
      hint: error.details?.hint,
    });
  }
}

/**
 * Records one daemon-level event. These run outside any request, so there is no request scope and no
 * resolved debug level to inherit; debug is forced on for the same reason the #2681 handoff forces it —
 * the event is the point of the record and must not be dropped by a level that was never set for it.
 */
async function emitDaemonDiagnostic(
  logPath: string,
  phase: string,
  data: Record<string, unknown>,
): Promise<void> {
  await withDaemonDiagnosticsScope({ logPath }, () => {
    emitDiagnostic({ level: 'warn', phase, data });
  });
}

async function finishDaemonRegistration(params: {
  registration: DaemonRegistrationOwner;
  infoPath: string;
  logPath: string;
  outcome?: Parameters<DaemonRegistrationOwner['finish']>[0];
}): Promise<void> {
  try {
    const removal = await params.registration.finish(params.outcome);
    if (removal.state !== 'removed' && removal.state !== 'absent') {
      await emitDaemonDiagnostic(params.logPath, 'daemon_info_removal_declined', {
        infoPath: params.infoPath,
        removed: false,
        reason: removal.state,
        ...(removal.state === 'replaced' ? { registeredPid: removal.identity.pid } : {}),
      });
    }
  } catch (error) {
    await emitDaemonDiagnostic(params.logPath, 'daemon_registration_finish_failed', {
      error: normalizeError(error),
    });
  }
}

async function noteDaemonMetadataLoss(params: {
  infoPath: string;
  logPath: string;
  loss: DaemonMetadataLoss;
}): Promise<void> {
  await emitDaemonDiagnostic(params.logPath, 'daemon_metadata_lost', {
    infoPath: params.infoPath,
    ...params.loss,
  });
}

/**
 * Starts the watch that reports this daemon's registration being taken over, and returns the handle
 * that stops it. It is armed only once this process has published its own record: before publication
 * the file legitimately describes a predecessor, and losing that is not this daemon's event.
 */
function armDaemonMetadataLossWatch(
  stateDir: string,
  infoPath: string,
  logPath: string,
  owner: OwnerIdentity,
): () => void {
  return watchDaemonMetadataLoss({
    infoPath,
    stateDir,
    owner,
    onLoss: (loss) => void noteDaemonMetadataLoss({ infoPath, logPath, loss }).catch(() => {}),
  });
}

export async function startDaemonRuntime(
  options: DaemonRuntimeOptions = {},
): Promise<DaemonRuntimeController | null> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const daemonPaths = resolveDaemonPaths(env.AGENT_DEVICE_STATE_DIR);
  const { baseDir, infoPath, logPath, sessionsDir } = daemonPaths;
  const daemonServerMode = resolveDaemonServerMode(env.AGENT_DEVICE_DAEMON_SERVER_MODE);
  const retainArtifacts = isEnvTruthy(env.AGENT_DEVICE_RETAIN_ARTIFACTS);
  // ADR 0029: a policy that cannot be read or validated stops startup; the daemon never runs
  // with a weaker policy than its operator named.
  let daemonPolicy: DaemonPolicy | undefined;
  try {
    daemonPolicy = loadDaemonPolicy(env);
  } catch (error) {
    stderr.write(`Daemon error: ${asAppError(error).message}\n`);
    exit(1);
    return null;
  }

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
  const daemonIdentity = readCurrentOwnerIdentity();
  const daemonCodeOrigin = resolveDaemonCodeOrigin();
  const daemonCodeSignature = resolveDaemonCodeSignature();
  const providerComposition = await createDaemonProviderRuntimeComposition(env);
  const providerDeviceRuntimes = [...providerComposition.runtimes];
  const deviceRuntimeGateway = createPlatformRuntimeGateway({
    assertShutdownAllowed: daemonPolicy
      ? () => assertDaemonPolicyAllowsCapability(daemonPolicy, 'device-shutdown')
      : undefined,
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
  installProviderDeviceAdmission({ isActive: (device) => isActiveProviderDevice(device) });
  installInteractorResolution({ resolve: getInteractor });
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
    providerCredentials: readDaemonProviderCredentials(env, baseDir),
    providerDeviceRuntimeScope: providerRuntimeProviders.providerDeviceRuntimeScope,
    trackDownloadableArtifact,
    daemonPolicy,
  });

  let stopMetadataLossWatch: () => void = () => {};

  const emitFatalDiagnostic = async (error: unknown): Promise<void> => {
    await withDaemonDiagnosticsScope({ logPath }, () => {
      emitDiagnostic({
        level: 'error',
        phase: 'daemon_fatal',
        data: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  };

  const shutdownClaimLedger = createDaemonShutdownClaimLedger();

  const teardownDaemonSession = async (ref: SessionRef): Promise<void> => {
    const session = sessionStore.resolveCurrent(ref) ?? ref.session;
    try {
      await teardownDaemonSessionForShutdown({
        ref,
        sessionStore,
        stderr,
        finalizeApplicationLifecycle: async (sessionToFinalize, runtimeHints) =>
          await finalizeDaemonSessionApplicationLifecycle({
            gateway: deviceRuntimeGateway,
            scope: createDaemonRecoveryPlatformScope(),
            session: sessionToFinalize,
            stateDir: baseDir,
            runtimeHints,
          }),
        afterSuccessfulTeardown: shutdownClaimLedger.releaseClaim,
      });
    } finally {
      shutdownClaimLedger.finalize(session);
    }
  };

  const teardownDaemonSessions = async (): Promise<void> => {
    sessionStore.closeAdmission();
    const sessionsToStop = sessionStore.listRefs();
    await Promise.all(sessionsToStop.map(teardownDaemonSession));
  };

  // #2833: settles the resources of a session this daemon expires for idleness. Deliberately NOT
  // `teardownDaemonSession`: that one exists for a daemon that is leaving, so it hands a healthy
  // execution host to its successor and deletes the session whether the
  // bounded teardown finished or not. An idle expiry is the opposite situation — the daemon is
  // staying alive, there is no successor, and a session whose resources would not release has to
  // survive so the next pass can retry rather than leave a claim owned by a process that no longer
  // knows what it holds. So: resources, then the platform finalization that stops the execution host
  // and releases its lease, then the claim, cleared last, by the reaper.
  const settleIdleExpiredSession = async (ref: SessionRef): Promise<void> => {
    const session = sessionStore.resolveCurrent(ref) ?? ref.session;
    const sessionName = ref.address;
    const runtimeHints = runtimeHintValues(sessionStore.getRuntimeHints(sessionName));
    await teardownSessionResources({
      appLog: 'run',
      ref,
      sessionStore,
      stateDir: baseDir,
      platformCleanup: platformResourceCleanup,
    });
    await finalizeDaemonSessionApplicationLifecycle({
      gateway: deviceRuntimeGateway,
      scope: createDaemonRecoveryPlatformScope(),
      session,
      stateDir: baseDir,
      runtimeHints,
      // The one caller that must say so: this daemon is staying alive, so there is no shutdown
      // phase a healthy runner could be deferred to. Taking the ordinary-close path stops the
      // runner and releases its lease instead of parking it until process exit.
      daemonLeaving: false,
    });
    // ADR 0012 R7 binds this teardown too — the healed `.ad` is committed by
    // `SessionStore.finalizeRepairTeardown` — but NOT from in here. That call publishes the script
    // and stamps COMMITTED onto the record it is handed, which makes it part of ENDING the session
    // rather than part of releasing its resources, and a settle that cannot confirm its claim gone
    // holds the session back to retry. The reaper runs it once the expiry is committed to.
  };

  const sessionIdleExpiry = createSessionIdleExpiry({
    sessionStore,
    idleExpiryMs: resolveSessionIdleExpiryMs(env),
    executionLocks: getLeaseRegistryExecutionLocks(leaseRegistry),
    settleSession: settleIdleExpiredSession,
    // The same bounded teardown budget every other session teardown gets. It bounds only how long a
    // sweep waits, never the settle itself, so a stuck recorder cannot make a sweep hang but also
    // cannot make an expiry give up on a device that does come free.
    settleBudgetMs: (session) => resolveDaemonSessionTeardownTimeoutMs(session),
    withinDiagnosticsScope: async (run) => await withDaemonDiagnosticsScope({ logPath }, run),
    // An expiry can be the event that makes this daemon fully idle, and no request follows it to
    // arm the process-level reap.
    onSessionExpired: () => {
      idleReap.noteActivity();
    },
  });

  // Reaps this daemon process when it sits fully idle (no open sessions, no
  // in-flight requests, no active recording) past AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS.
  // `shutdown` is defined below but only invoked asynchronously by the timer,
  // well after this closure captures it.
  let shuttingDown = false;
  const inFlightRequests = new Set<ReturnType<DaemonInvokeFn>>();
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => inFlightRequests.size,
    hasRetainedLeases: () => leaseRegistry.hasRetainedLeases(),
    onIdleReap: () => {
      void shutdown();
    },
    env,
  });

  const handleRequest: DaemonInvokeFn = async (req) => {
    if (shuttingDown)
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Daemon is shutting down.',
          details: { reason: 'daemon_shutting_down' },
        },
      };
    idleReap.cancel();
    const dispatch = dispatchRequest(req);
    inFlightRequests.add(dispatch);
    try {
      return await dispatch;
    } finally {
      inFlightRequests.delete(dispatch);
      idleReap.noteActivity();
      // One hook covers every way a deadline changes: an `open` has added one, a `close` has removed
      // one, and any other command has just re-stamped the session it ran on. Reading the session set
      // here — after the request's own session stamp landed inside its execution lock — is what keeps
      // the reaper's view of a session's deadline identical to the lock-guarded one.
      sessionIdleExpiry.noteSessionsChanged();
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
        resolveRequestDiagnosticsPath: daemonPolicy?.requiredLeaseBackend
          ? undefined
          : (ref) =>
              resolveSessionRequestLogPath(
                sessionStore.resolveSessionDir(ref.session),
                ref.requestId,
              ),
      });
      servers.push(httpServer);
      httpPort = await listenHttpServer(httpServer);
    }
    return { servers, socketPort, httpPort };
  };

  const publishDaemonInfo = (socketPort: number | undefined, httpPort: number | undefined) => {
    registration.publish({
      socketPort,
      httpPort,
      token,
      version,
      codeOrigin: daemonCodeOrigin,
      codeSignature: daemonCodeSignature,
      policyDigest: daemonPolicy?.digest,
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

  const acquisition = await tryAcquireDaemonRegistration(daemonPaths);
  if (acquisition.status !== 'acquired') {
    await Promise.allSettled(
      providerDeviceRuntimes.map(async (runtime) => await runtime.shutdown()),
    );
    stderr.write(`Daemon registration ${acquisition.status}; exiting.\n`);
    exit(DAEMON_STARTUP_EXIT_CODES[acquisition.status]);
    return null;
  }
  const registration = acquisition.owner;

  let servers: DaemonServer[] = [];
  let socketPort: number | undefined;
  let httpPort: number | undefined;
  const startupDiagnostics: ResourceDiagnostic[] = [];
  try {
    await platformDaemonLifecycleOwners.configureForDaemonLock({
      stateDir: baseDir,
      hasDeviceClaimAuthority: processOwnsActiveDeviceClaim,
      onDiagnostic: (diagnostic) => startupDiagnostics.push(diagnostic),
    });
    const legacyMarkerRecovery =
      await platformDaemonLifecycleOwners.recoverLegacyAppLogMarkers(sessionsDir);
    appLogAdmissionLedger.retainLegacyMarkers(legacyMarkerRecovery.retained);
    for (const markerPath of legacyMarkerRecovery.recovered) {
      startupDiagnostics.push({
        phase: 'app_log_legacy_marker_recovered',
        resourcePath: markerPath,
        data: {},
      });
    }
    for (const retained of legacyMarkerRecovery.retained) {
      startupDiagnostics.push({
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
      onDiagnostic: (diagnostic) => startupDiagnostics.push(diagnostic),
    });
    await reapOwnedProcessRecordsAtStartup(ownedProcessRecords, {
      openWebSessionNames: openWebSessionNames(sessionStore),
      purposes: ['simctl-screen-recording'],
      termTimeoutMs: DAEMON_RECORDING_REAP_TERM_TIMEOUT_MS,
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
    stopMetadataLossWatch = armDaemonMetadataLossWatch(baseDir, infoPath, logPath, daemonIdentity);
    await flushDaemonStartupDiagnostics(logPath, startupDiagnostics);
    await noteSkippedProviderRuntimes(logPath, providerComposition.skipped);
    // After publication: publishDaemonInfo truncates daemon.log, so anything
    // written before it is lost — including reconciliation diagnostics.
    await reconcileDeviceClaimsForDaemonStartup(
      logPath,
      createOwnerScopedDeviceClaimReconciler(createDaemonRecoveryPlatformScope()),
      baseDir,
    );
    // Arms the initial idle-reap timer: a daemon that starts and never
    // receives a request must still be able to reap itself.
    idleReap.noteActivity();
    // The #2833 deadline needs no equivalent arm: the store is empty until a request puts a session
    // in it, and that request's own completion re-arms the reaper.
  } catch (error) {
    const appErr = asAppError(error);
    stderr.write(`Daemon error: ${appErr.message}\n`);
    closeServersBestEffort(servers);
    stopMetadataLossWatch();
    await Promise.allSettled(
      providerDeviceRuntimes.map(async (runtime) => await runtime.shutdown()),
    );
    await finishDaemonRegistration({ registration, infoPath, logPath });
    await platformDaemonLifecycleOwners.clearDaemonLockConfiguration();
    exit(1);
    return null;
  }

  // Spawn the PNG worker ahead of the first screenshot request so its
  // cold-start cost is not paid on a user-visible call. Best effort: when it
  // cannot start, PNG processing falls back to the in-process sync path.
  prewarmPngWorker();

  const shutdown = async (shutdownOptions: { exitCode?: number; cause?: unknown } = {}) => {
    idleReap.cancel();
    sessionIdleExpiry.cancel();
    if (shuttingDown) return;
    shuttingDown = true;
    stopMetadataLossWatch();
    if (shutdownOptions.cause) {
      await emitFatalDiagnostic(shutdownOptions.cause);
    }
    await closeDaemonServers(servers);
    await Promise.allSettled(inFlightRequests);
    // Hand healthy runners off before durable session teardown. The lifecycle gateway later
    // terminates only still-owned generations once all resources have finalized.
    //
    // The scope is what makes this step observable: a SIGTERM shutdown has no request, and therefore
    // no diagnostics scope, so `emitDiagnostic` would drop every detach reason. Daemon debug level is
    // forced on here because the declines are the point of the record — a handoff that silently
    // skipped is indistinguishable from a rebuild (#2681).
    try {
      await withDaemonDiagnosticsScope({ logPath }, async () => {
        await applicationLifecycle.detachForDaemonShutdown();
      });
    } catch {}
    expiredProviderLeaseReleaser.beginShutdown();
    await teardownDaemonSessions();
    await withDaemonDiagnosticsScope({ logPath }, async () => {
      await finalizeDaemonLeases({
        leaseRegistry,
        expiredProviderLeaseReleaser,
        timeoutMs: DAEMON_LEASE_RELEASE_TIMEOUT_MS,
      });
    });
    try {
      await platformDaemonLifecycleOwners.resetAndroidSnapshotHelper();
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
    await finishDaemonRegistration({
      registration,
      infoPath,
      logPath,
      outcome: { providerReleases: providerReleaseDrain, claims: shutdownClaimLedger.claims },
    });
    await platformDaemonLifecycleOwners.clearDaemonLockConfiguration();
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
  await withDaemonDiagnosticsScope({ logPath }, async () => {
    try {
      const summary = await reconcileOrphanedDeviceClaims(reconcile, stateDir);
      if (summary.examined > 0) {
        emitDiagnostic({ phase: 'device_claim_reconcile', data: summary });
      }
    } catch (error) {
      emitDiagnostic({
        level: 'warn',
        phase: 'device_claim_reconcile_failed',
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  });
}

export async function cleanupWebBrowserOrphansForDaemonStartup(params: {
  stateDir: string;
  sessionStore: SessionStore;
  ownedProcessRecords?: OwnedProcessRecordStore;
}): Promise<void> {
  try {
    await platformDaemonLifecycleOwners.cleanupManagedWebOrphans({
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
