import { recoverAppLogResourcesAfterDaemonLock } from '@agent-device/capture-kit/app-log-resource-recovery';
import { resolveSessionRequestLogPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  createOwnerScopedDeviceClaimReconciler,
  createRecoveryPlatformScope,
  type ClaimRecoveryGatewayFactory,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import crypto from 'node:crypto';
import { asAppError, AppError, normalizeError } from '@agent-device/kernel/errors';
import { SessionStore } from '../../core/session-store.ts';
import {
  DAEMON_CAPABILITIES,
  resolveDaemonPaths,
  resolveDaemonServerMode,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { createDaemonHttpServer } from './http-server.ts';
import { trackDownloadableArtifact } from '../../resources/artifact-tracking.ts';
import {
  installProviderDeviceAdmission,
  type ProviderDeviceAdmission,
} from '../../core/provider-device-admission.ts';
import {
  loadDaemonPolicy,
  type DaemonPolicy,
} from '@agent-device/daemon-contracts/daemon-policy-file';
import { assertDaemonPolicyAllowsCapability } from '../../core/daemon-policy.ts';
import {
  installInteractorResolution,
  type InteractorResolution,
} from '../../core/interactor-resolution.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { createRequestHandler, type RequestRouterDeps } from '../request-router.ts';
import {
  createLeaseSessionEnd,
  getLeaseRegistryExecutionLocks,
} from '../request-execution-scope.ts';
import type { LeaseEndReason } from '../../sessions/lease-lifecycle.ts';
import { stopSessionAppLog, teardownSessionResources } from '../../sessions/session-teardown.ts';
import { resolveDaemonSessionTeardownTimeoutMs } from '../../sessions/session-teardown-budget.ts';
import { finalizeDaemonSessionApplicationLifecycle } from '../application-lifecycle-recovery.ts';
import { runtimeHintValues } from '../../sessions/session-runtime.ts';
import { closeDaemonServers } from './server-shutdown.ts';
import type { DaemonInvokeFn } from '../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../core/session-state.ts';
import type { RuntimeHintValues } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  createDaemonIdleReap,
  createDaemonQuiesce,
  daemonShuttingDownResponse,
} from '../../sessions/server/daemon-idle-reap.ts';
import { withDaemonDiagnosticsScope } from '@agent-device/daemon-contracts/daemon-diagnostics-scope';
import { createSessionIdleExpiry } from './daemon-session-idle-expiry.ts';
import { resolveSessionIdleExpiryMs } from '../session-idle-expiry.ts';
import { finalizeDaemonLeases } from './daemon-lease-finalizer.ts';
import {
  processOwnsActiveDeviceClaim,
  reconcileOrphanedDeviceClaims,
  type DeviceClaimReconciler,
} from '@agent-device/daemon-contracts/device-claims';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import { createAudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import { createPerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { emitDiagnostic, type ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  readCurrentOwnerIdentity,
  reapOwnedProcessRecordsAtStartup,
  type OwnedProcessRecordStore,
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
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { watchDaemonMetadataLoss } from './daemon-metadata-loss.ts';
import {
  createSocketServer,
  listenHttpServer,
  listenNetServer,
  type DaemonServer,
} from './transport.ts';
import { prewarmPngWorker, terminatePngWorker } from '@agent-device/capture-kit/png-worker-client';
import { openWebSessionNames } from '../../sessions/web-session-names.ts';
import { createAppLogAdmissionLedger } from '../../resources/app-log-admission-ledger.ts';
import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type { PlatformOwnerLifecycle } from '../../core/platform-owner-lifecycle.ts';
import type { PlatformResourceCleanup } from '../../core/platform-resource-cleanup.ts';
import type {
  LeaseLifecycleProvider,
  ProviderDeviceRuntime,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';

const DAEMON_LEASE_RELEASE_TIMEOUT_MS = 1_000;
const LEASE_EXPIRY_SWEEP_INTERVAL_MS = 1_000;
const DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DAEMON_PROVIDER_RELEASE_DRAIN_TIMEOUT_MS = 2_000;
// An orphaned `simctl recordVideo` releases the host-wide recording lock only after it finishes
// finalizing on SIGINT; force-killing it sooner leaves every later recording failing with EBUSY
// (#2170). Bound the grace to the recorder purpose, so daemon startup stays under the client budget.
const DAEMON_RECORDING_REAP_TERM_TIMEOUT_MS = 5_000;

type WritableOutput = {
  write: (chunk: string) => unknown;
};

/**
 * Every capability the daemon runtime cannot construct for itself: the platform and provider
 * runtimes, host diagnostics, credential fingerprinting, resource cleanup, the platform lifecycle
 * owners, and the request-router inputs that name them. The server owns the paths, the policy, and
 * the session store, and asks the root for the rest through a `composeDeps` factory — the process
 * root's implementation is `src/daemon-composition.ts` (ADR 0019). All members are required: a
 * daemon process either receives the root's composition or cannot start, and a test passes the
 * same factory, so the production assembly is the one every runtime test boots.
 */
export type DaemonRuntimeDeps = Readonly<{
  ownedProcessRecords: OwnedProcessRecordStore;
  hostDiagnostics: HostDiagnostics;
  ownerLifecycle: PlatformOwnerLifecycle;
  providerDeviceRuntimes: readonly ProviderDeviceRuntime[];
  /**
   * Provider runtimes the composition skipped. Data only: this server records each one as a
   * `provider_runtime_skipped` diagnostic after publishing its registration, so log emission
   * stays in this module.
   */
  skippedProviderRuntimes: readonly Readonly<{ provider: string; error: AppError }>[];
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
    | 'providerRuntimeRequiredIds'
    | 'providerDeviceRuntimeScope'
  >;
}>;

/** Everything the composition factory needs that the server owns: paths, policy, and the store. */
export type DaemonRuntimeDepsInput = Readonly<{
  env: NodeJS.ProcessEnv;
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

export type DaemonRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  stdout?: WritableOutput;
  stderr?: WritableOutput;
  exit?: (code: number) => void;
  registerProcessHandlers?: boolean;
  /** The root's runtime composition, as a factory so the server owns paths, policy, and store. */
  composeDeps: ComposeDaemonRuntimeDeps;
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
    onLoss: (loss) =>
      void emitDaemonDiagnostic(logPath, 'daemon_metadata_lost', {
        infoPath,
        ...loss,
      }).catch(() => {}),
  });
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
  ref: SessionRef;
  sessionStore: SessionStore;
  stderr: WritableOutput;
  platformCleanup: PlatformResourceCleanup;
  finalizeApplicationLifecycle?: (
    session: SessionState,
    runtimeHints: RuntimeHintValues,
  ) => Promise<void>;
  afterSuccessfulTeardown?: (session: SessionState) => Promise<void>;
}): Promise<void> {
  const {
    ref,
    sessionStore,
    stderr,
    platformCleanup,
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
          platformCleanup,
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

export async function startDaemonRuntime(
  options: DaemonRuntimeOptions,
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
  // with a weaker policy than its operator named. The server loads it before composing any
  // runtime, so no capability is ever built under a policy that failed validation.
  let daemonPolicy: DaemonPolicy | undefined;
  try {
    daemonPolicy = loadDaemonPolicy(env);
  } catch (error) {
    stderr.write(`Daemon error: ${asAppError(error).message}\n`);
    exit(1);
    return null;
  }
  // Derived here, beside the policy it reads: the server hands the same refusal to the root's
  // composition, so a runtime can never be built without the operator's shutdown gate.
  const assertShutdownAllowed = daemonPolicy
    ? () => assertDaemonPolicyAllowsCapability(daemonPolicy, 'device-shutdown')
    : undefined;

  const sessionStore = new SessionStore(sessionsDir);
  const deps = await options.composeDeps({
    env,
    baseDir,
    sessionsDir,
    assertShutdownAllowed,
    resolveSessionDir: (sessionId) => sessionStore.resolveSessionDir(sessionId),
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: sessionStore.resolveAppLogPath(sessionId),
      pidPath: sessionStore.resolveAppLogPidPath(sessionId),
    }),
    openWebSessionNames: () => openWebSessionNames(sessionStore),
  });
  const appLogAdmissionLedger = createAppLogAdmissionLedger();
  const audioProbeAdmissionLedger = createAudioProbeAdmissionLedger();
  const perfCaptureAdmissionLedger = createPerfCaptureAdmissionLedger();
  const screenRecordingAdmissionLedger = createScreenRecordingAdmissionLedger();
  const version = readVersion();
  const token = crypto.randomBytes(24).toString('hex');
  const daemonIdentity = readCurrentOwnerIdentity();
  const daemonCodeOrigin = resolveDaemonCodeOrigin();
  const daemonCodeSignature = resolveDaemonCodeSignature();
  const providerDeviceRuntimes = deps.providerDeviceRuntimes;
  const deviceRuntimeGateway = deps.deviceRuntimeGateway;
  const applicationLifecycle = deviceRuntimeGateway.applicationLifecycle;
  if (!applicationLifecycle) {
    throw new AppError('COMMAND_FAILED', 'Platform lifecycle gateway is not configured.', {
      reason: 'runtime-gateway-missing',
    });
  }
  installProviderDeviceAdmission(deps.providerDeviceAdmission);
  installInteractorResolution(deps.interactorResolution);
  const expiredProviderLeaseReleaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: deps.leaseLifecycleProvider,
    providerRuntimeIds: deps.providerRuntimeIds,
    recoverExpiredLease: deps.recoverExpiredLease,
    stateDir: baseDir,
    recoverableProviderIds: deps.recoverableProviderIds,
  });
  void expiredProviderLeaseReleaser.retryPending();
  const leaseRegistry = new LeaseRegistry({
    maxActiveSimulatorLeases: parseIntegerEnv(env.AGENT_DEVICE_MAX_SIMULATOR_LEASES),
    defaultLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_TTL_MS),
    minLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_MIN_TTL_MS),
    maxLeaseTtlMs: parseIntegerEnv(env.AGENT_DEVICE_LEASE_MAX_TTL_MS),
    onLeaseExpired: (lease) => {
      void expiredProviderLeaseReleaser.release(lease);
      void endSessionsForLease(lease.leaseId, 'LEASE_EXPIRED');
    },
  });
  // The registry only notices an expired lease when something calls it; this sweep ends an
  // abandoned lease (and, through `onLeaseExpired`, its session and claim) without a later request.
  const leaseExpirySweep = setInterval(
    () => leaseRegistry.consumeExpiredLeases(),
    LEASE_EXPIRY_SWEEP_INTERVAL_MS,
  );
  leaseExpirySweep.unref();
  const dispatchRequest = createRequestHandler({
    logPath,
    token,
    sessionStore,
    leaseRegistry,
    endSessionsForLease: async (leaseId) => await endSessionsForLease(leaseId, 'LEASE_RELEASED'),
    appLogAdmissionLedger,
    audioProbeAdmissionLedger,
    perfCaptureAdmissionLedger,
    hostDiagnostics: deps.hostDiagnostics,
    screenRecordingAdmissionLedger,
    daemonPolicy,
    trackDownloadableArtifact,
    // The facts the deps declare at the top level, offered to the router from that one place.
    deviceRuntimeGateway,
    claimRecoveryGateway: deps.claimRecoveryGateway,
    platformResourceCleanup: deps.platformResourceCleanup,
    leaseLifecycleProvider: deps.leaseLifecycleProvider,
    providerRuntimeIds: deps.providerRuntimeIds,
    ...deps.requestRouter,
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
        platformCleanup: deps.platformResourceCleanup,
        finalizeApplicationLifecycle: async (sessionToFinalize, runtimeHints) =>
          await finalizeDaemonSessionApplicationLifecycle({
            gateway: deviceRuntimeGateway,
            scope: createRecoveryPlatformScope(),
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
      platformCleanup: deps.platformResourceCleanup,
    });
    await finalizeDaemonSessionApplicationLifecycle({
      gateway: deviceRuntimeGateway,
      scope: createRecoveryPlatformScope(),
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

  const leaseSessionEnd = createLeaseSessionEnd({
    sessionStore,
    executionLocks: getLeaseRegistryExecutionLocks(leaseRegistry),
    teardownSession: settleIdleExpiredSession,
    withinDiagnosticsScope: async (run) => await withDaemonDiagnosticsScope({ logPath }, run),
  });

  const endSessionsForLease = async (leaseId: string, reason: LeaseEndReason): Promise<void> => {
    await leaseSessionEnd.end(leaseId, reason);
    idleReap.noteActivity();
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

  // The quiesce request is answered before dispatch and never joins `inFlightRequests`, so the
  // count it reads needs no allowance for it. The servers listen and `daemon.json` is published
  // before `shutdown` exists, and a daemon answers `draining` only once it has a drain path to run.
  let startingUp = true;
  const quiesce = createDaemonQuiesce({
    token,
    identity: { pid: daemonIdentity.pid, processStartTime: daemonIdentity.startTime },
    sessionStore,
    leaseRegistry,
    inFlightRequestCount: () => inFlightRequests.size,
    startingUp: () => startingUp,
    drain: () => {
      void shutdown();
    },
  });

  const handleRequest: DaemonInvokeFn = quiesce.admit(async (req) => {
    if (shuttingDown) return daemonShuttingDownResponse();
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
  });

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
        endSessionsForLease: async (leaseId) =>
          await endSessionsForLease(leaseId, 'LEASE_RELEASED'),
        token,
        retainArtifacts,
        env,
        // A `/rpc` flow can reject after its own catches failed to answer, leaving this server's
        // refusal as the only record the failure gets. It has no request scope — that opens later,
        // inside the handler — so it reports through the pair every other out-of-request daemon
        // event uses: a diagnostic scoped to the daemon log, and the runtime's error stream.
        onUnownedRequestFailure: (failure) => {
          // The record goes first: an injected stream that throws on write must not cost `daemon.log`
          // the event. The throw itself reaches the server's guard, which is the answer's owner.
          // `.catch` because a detached diagnostic has nowhere to report its own failure — the same
          // shape as the metadata-loss watch above.
          void emitDaemonDiagnostic(logPath, 'daemon_rpc_request_flow_failed', {
            code: failure.code,
            message: failure.message,
          }).catch(() => {});
          stderr.write(`Daemon error: ${failure.message}\n`);
        },
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
      capabilities: DAEMON_CAPABILITIES,
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
    await deps.ownerLifecycle.configureForDaemonLock({
      stateDir: baseDir,
      hasDeviceClaimAuthority: processOwnsActiveDeviceClaim,
      onDiagnostic: (diagnostic) => startupDiagnostics.push(diagnostic),
    });
    const legacyMarkerRecovery = await deps.ownerLifecycle.recoverLegacyAppLogMarkers(sessionsDir);
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
      scope: createRecoveryPlatformScope(),
      onDiagnostic: (diagnostic) => startupDiagnostics.push(diagnostic),
    });
    await reapOwnedProcessRecordsAtStartup(deps.ownedProcessRecords, {
      openWebSessionNames: openWebSessionNames(sessionStore),
      purposes: ['simctl-screen-recording'],
      termTimeoutMs: DAEMON_RECORDING_REAP_TERM_TIMEOUT_MS,
    });
    await deps.cleanupManagedWebOrphans({
      stateDir: baseDir,
      openWebSessionNames: openWebSessionNames(sessionStore),
      ownedProcessRecords: deps.ownedProcessRecords,
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
    for (const skipped of deps.skippedProviderRuntimes) {
      await emitDaemonDiagnostic(logPath, 'provider_runtime_skipped', {
        provider: skipped.provider,
        code: skipped.error.code,
        message: skipped.error.message,
        hint: skipped.error.details?.hint,
      });
    }
    // After publication: publishDaemonInfo truncates daemon.log, so anything
    // written before it is lost — including reconciliation diagnostics.
    await reconcileDeviceClaimsForDaemonStartup(
      logPath,
      createOwnerScopedDeviceClaimReconciler({
        scope: createRecoveryPlatformScope(),
        composeGateway: deps.claimRecoveryGateway,
      }),
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
    await deps.ownerLifecycle.clearDaemonLockConfiguration();
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
    leaseSessionEnd.cancel();
    clearInterval(leaseExpirySweep);
    if (shuttingDown) return;
    shuttingDown = true;
    stopMetadataLossWatch();
    if (shutdownOptions.cause) {
      await emitFatalDiagnostic(shutdownOptions.cause);
    }
    await closeDaemonServers(servers);
    await Promise.allSettled(inFlightRequests);
    await leaseSessionEnd.drain();
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
      await deps.ownerLifecycle.resetAndroidSnapshotHelper();
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
    await deps.ownerLifecycle.clearDaemonLockConfiguration();
    exit(shutdownOptions.exitCode ?? 0);
  };

  startingUp = false;

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
