import { recoverAppLogResourcesAfterDaemonLock } from '@agent-device/capture-kit/app-log-resource-recovery';
import { resolveSessionRequestLogPath } from '@agent-device/daemon-contracts/session-artifact-paths';
import {
  createOwnerScopedDeviceClaimReconciler,
  createRecoveryPlatformScope,
  type ClaimRecoveryGatewayFactory,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import crypto from 'node:crypto';
import { asAppError, AppError } from '@agent-device/kernel/errors';
import { SessionStore } from '../../core/session-store.ts';
import {
  DAEMON_CAPABILITIES,
  resolveDaemonPaths,
  resolveDaemonServerMode,
  type DaemonRuntimeOwnership,
} from '@agent-device/daemon-contracts/daemon-resolution';
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
import { teardownSessionResources } from '../../sessions/session-teardown.ts';
import { resolveDaemonSessionTeardownTimeoutMs } from '../../sessions/session-teardown-budget.ts';
import { finalizeDaemonSessionApplicationLifecycle } from '../application-lifecycle-recovery.ts';
import { runtimeHintValues } from '../../sessions/session-runtime.ts';
import {
  closeDaemonServers,
  teardownDaemonSessionForShutdown,
  type WritableOutput,
  createPluginClose,
  createStartupRollback,
  describeUnfinishedShutdownWork,
  settleWithinBudget,
  type ShutdownReport,
  type StartupRollback,
} from './server-shutdown.ts';
import type { DaemonInvokeFn } from '../../core/daemon-request.ts';
import type { SessionRef } from '../../core/session-state.ts';
import {
  createDaemonIdleReap,
  createDaemonLifecycleAdmission,
  daemonShuttingDownResponse,
} from '../../sessions/server/daemon-idle-reap.ts';
import { withDaemonDiagnosticsScope } from '@agent-device/daemon-contracts/daemon-diagnostics-scope';
import { createSessionIdleExpiry } from './daemon-session-idle-expiry.ts';
import { resolveSessionIdleExpiryMs } from '../session-idle-expiry.ts';
import { finalizeDaemonLeases } from './daemon-lease-finalizer.ts';
import { processOwnsActiveDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { createDaemonShutdownClaimLedger } from './daemon-shutdown-claims.ts';
import { createAudioProbeAdmissionLedger } from '@agent-device/capture-kit/audio-probe-admission-ledger';
import { createPerfCaptureAdmissionLedger } from '@agent-device/capture-kit/perf-capture-admission-ledger';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { withCommandHost } from '@agent-device/host-kit/command';
import { cancelAllRequests } from '@agent-device/host-kit/request';
import {
  createRuntimeStateHandle,
  type RuntimeStateHandle,
} from '@agent-device/host-kit/runtime-slots';
import { emitDiagnostic, type ResourceDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  readCurrentOwnerIdentity,
  reapOwnedProcessRecordsAtStartup,
  type OwnedProcessRecordStore,
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
import {
  recordDaemonStartupMarker,
  removeDaemonStartupPhasesFile,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-startup-phases';
import { retainPngWorker } from '@agent-device/capture-kit/png-worker-client';
import { openWebSessionNames } from '../../sessions/web-session-names.ts';
import { createAppLogAdmissionLedger } from '../../resources/app-log-admission-ledger.ts';
import type { AppLogSessionArtifacts } from '@agent-device/contracts/app-log-runtime';
import type { PlatformOwnerLifecycle } from '../../core/platform-owner-lifecycle.ts';
import type {
  LeaseLifecycleProvider,
  ProviderExpiredLeaseRecovery,
} from '@agent-device/contracts/device';
import type { HostDiagnostics } from '@agent-device/contracts/host-diagnostics';
import type {
  PluginCleanupOutcome,
  PluginInventoryEntry,
} from '@agent-device/contracts/plugin-inventory';

const DAEMON_LEASE_RELEASE_TIMEOUT_MS = 1_000;
const LEASE_EXPIRY_SWEEP_INTERVAL_MS = 1_000;
const DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS = 1_000;
const DAEMON_PLATFORM_OWNER_SHUTDOWN_TIMEOUT_MS = 5_000;
const DAEMON_PROVIDER_RELEASE_DRAIN_TIMEOUT_MS = 2_000;
// A handler that ignores cancellation must not hold `close()` forever; past this it is reported
// abandoned and the registration stays held while the process lives.
const DAEMON_REQUEST_DRAIN_TIMEOUT_MS = 5_000;
// An orphaned `simctl recordVideo` releases the host-wide recording lock only after it finishes
// finalizing on SIGINT; force-killing it sooner leaves every later recording failing with EBUSY
// (#2170). Bound the grace to the recorder purpose, so daemon startup stays under the client budget.
const DAEMON_RECORDING_REAP_TERM_TIMEOUT_MS = 5_000;

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

export type DaemonRuntimeOptions = {
  host: HostEnvironment;
  stdout?: WritableOutput;
  stderr?: WritableOutput;
  /** The root's runtime composition, as a factory so the server owns paths, policy, and store. */
  composeDeps: ComposeDaemonRuntimeDeps;
  /** Shutdown time budgets, for hosts and tests that need other than the defaults. */
  shutdownBudgets?: { requestDrainMs?: number; pluginMs?: number; ownerMs?: number };
  /**
   * Who owns this process. A host that started this runtime in its own process passes `embedded`: the
   * record says so, no idle timer ends the runtime, and it answers a shutdown request instead of a
   * quiesce. Defaults to a detached daemon. `unknown` is not offered: it is what a reader answers for a
   * record it cannot place, and a runtime always knows which of these two it is.
   */
  ownership?: DaemonRuntimeOwnership;
};

export type DaemonRuntimeController = {
  httpPort?: number;
  socketPort?: number;
  /**
   * Closes the runtime. Concurrent and repeated calls share one close, whose report every caller
   * receives. The runtime never exits the process: the executable owns signals and exit codes.
   */
  close: (options?: { cause?: unknown }) => Promise<ShutdownReport>;
  /** Settles once the runtime has closed, whoever closed it (an idle reap closes it unasked). */
  closed: Promise<ShutdownReport>;
  /** Runs `fn` as this runtime, for code that serves it from outside its own callbacks. */
  run: <T>(fn: () => T) => T;
  token: string;
};

/**
 * Thrown by {@link startDaemonRuntime} when the daemon must not run: its policy is unusable or
 * another daemon owns the state dir. `details.exitCode` is the code the executable exits with.
 */
export function daemonStartupExitCode(error: unknown): number {
  const exitCode = asAppError(error).details?.exitCode;
  return typeof exitCode === 'number' ? exitCode : 1;
}

/**
 * Starts one daemon runtime: the single entered runtime-state store, the command host, then the
 * composition and servers built inside both. Every read of per-runtime state (requests, close,
 * timers the startup spawns) runs within this handle, so two runtimes in one process never share
 * it and no module exposes a store of its own (#3794).
 */
export async function startDaemonRuntime(
  options: DaemonRuntimeOptions,
): Promise<DaemonRuntimeController> {
  const runtimeState = createRuntimeStateHandle();
  return await runtimeState.run(
    async () =>
      await withCommandHost({ host: options.host, requestEnv: undefined }, async () => {
        const rollback = createStartupRollback();
        rollback.onRollback(() => runtimeState.dispose());
        try {
          return await startDaemonRuntimeOnHost(options, rollback, runtimeState);
        } catch (error) {
          await rollback.run();
          throw error;
        }
      }),
  );
}

async function startDaemonRuntimeOnHost(
  options: DaemonRuntimeOptions,
  rollback: StartupRollback,
  runtimeState: RuntimeStateHandle,
): Promise<DaemonRuntimeController> {
  const { host } = options;
  const { env } = host;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  // Function-scoped import: these helpers stay out of the daemon entry's eager closure (ADR 0019).
  const {
    armDaemonMetadataLossWatch,
    emitDaemonDiagnostic,
    finishDaemonRegistration,
    flushDaemonStartupDiagnostics,
  } = await import('./daemon-startup-diagnostics.ts');
  const daemonPaths = resolveDaemonPaths(env.AGENT_DEVICE_STATE_DIR, { env, cwd: host.cwd });
  const { baseDir, infoPath, logPath, sessionsDir } = daemonPaths;
  const daemonServerMode = resolveDaemonServerMode(env.AGENT_DEVICE_DAEMON_SERVER_MODE);
  const retainArtifacts = isEnvTruthy(env.AGENT_DEVICE_RETAIN_ARTIFACTS);
  // ADR 0029: a policy that cannot be read or validated stops startup; the daemon never runs
  // with a weaker policy than its operator named. The server loads it before composing any
  // runtime, so no capability is ever built under a policy that failed validation.
  const daemonPolicy: DaemonPolicy | undefined = loadDaemonPolicy(env, host.cwd);
  // Derived here, beside the policy it reads: the server hands the same refusal to the root's
  // composition, so a runtime can never be built without the operator's shutdown gate.
  const assertShutdownAllowed = daemonPolicy
    ? () => assertDaemonPolicyAllowsCapability(daemonPolicy, 'device-shutdown')
    : undefined;

  const sessionStore = new SessionStore(sessionsDir);
  const deps = await options.composeDeps({
    host,
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
  const requestDrainTimeoutMs =
    options.shutdownBudgets?.requestDrainMs ?? DAEMON_REQUEST_DRAIN_TIMEOUT_MS;
  // The registry is the one plugin cleanup owner: closing it shuts each runtime down, then disposes
  // the plugin, and it is idempotent, so the final close, a startup rollback and the last release
  // all go through the same call.
  const pluginClose = createPluginClose({
    close: deps.shutdownProviderRuntimes,
    inventory: deps.pluginInventory,
    timeoutMs: options.shutdownBudgets?.pluginMs,
  });
  rollback.onRollback(async () => {
    await pluginClose.close();
  });
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
  rollback.onRollback(() => expiredProviderLeaseReleaser.shutdown());
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
  rollback.onRollback(() => clearInterval(leaseExpirySweep));
  const dispatchRequest = createRequestHandler({
    host,
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
    failedPlugins: deps.pluginInventory.filter(({ state }) => state === 'failed'),
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

  const shutdownClaimLedger = createDaemonShutdownClaimLedger(env);

  const teardownDaemonSession = async (ref: SessionRef): Promise<boolean> => {
    const session = sessionStore.resolveCurrent(ref) ?? ref.session;
    try {
      return await teardownDaemonSessionForShutdown({
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

  const teardownDaemonSessions = async (): Promise<ShutdownReport['sessions']> => {
    sessionStore.closeAdmission();
    const sessionsToStop = sessionStore.listRefs();
    const outcomes = await Promise.all(
      sessionsToStop.map(async (ref) => await teardownDaemonSession(ref).catch(() => false)),
    );
    const closedCount = outcomes.filter(Boolean).length;
    return { closed: closedCount, failed: outcomes.length - closedCount };
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
    env,
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
    env,
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
  // `close` is defined below but only invoked asynchronously by the timer,
  // well after this closure captures it.
  let shuttingDown = false;
  const inFlightRequests = new Set<ReturnType<DaemonInvokeFn>>();
  // Who owns this process decides what it publishes and which lifecycle request it answers. A host
  // that starts the runtime passes `embedded`; the daemon executable leaves it detached.
  const ownership = options.ownership ?? 'detached';
  const idleReap = createDaemonIdleReap({
    sessionStore,
    getInFlightRequestCount: () => inFlightRequests.size,
    hasRetainedLeases: () => leaseRegistry.hasRetainedLeases(),
    onIdleReap: () => {
      void close();
    },
    env,
    ownership,
  });

  rollback.onRollback(() => {
    idleReap.cancel();
    sessionIdleExpiry.cancel();
    leaseSessionEnd.cancel();
  });

  // Both lifecycle requests are answered before dispatch and never join `inFlightRequests`, so the
  // count they read needs no allowance for them. The servers listen and `daemon.json` is published
  // before `close` exists, and a daemon answers `draining` only once it has a drain path to run.
  let startingUp = true;
  const lifecycleAdmission = createDaemonLifecycleAdmission({
    token,
    identity: { pid: daemonIdentity.pid, processStartTime: daemonIdentity.startTime },
    sessionStore,
    leaseRegistry,
    inFlightRequestCount: () => inFlightRequests.size,
    startingUp: () => startingUp,
    drain: () => {
      void close();
    },
    ownership: () => ownership,
  });

  const handleRequest: DaemonInvokeFn = lifecycleAdmission.admit(async (req) => {
    if (shuttingDown) return daemonShuttingDownResponse();
    idleReap.cancel();
    const dispatch = runtimeState.run(() => dispatchRequest(req));
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
      plugins: deps.pluginInventory,
      ownership,
    });
    if (socketPort) stdout.write(`AGENT_DEVICE_DAEMON_PORT=${socketPort}\n`);
    if (httpPort) stdout.write(`AGENT_DEVICE_DAEMON_HTTP_PORT=${httpPort}\n`);
  };

  const acquisition = await tryAcquireDaemonRegistration(daemonPaths);
  if (acquisition.status !== 'acquired') {
    throw new AppError('COMMAND_FAILED', `Daemon registration ${acquisition.status}.`, {
      reason: 'daemon_registration_refused',
      status: acquisition.status,
      exitCode: DAEMON_STARTUP_EXIT_CODES[acquisition.status],
    });
  }
  const registration = acquisition.owner;
  rollback.onRollback(async () => {
    await deps.ownerLifecycle.clearDaemonLockConfiguration();
  });
  rollback.onRollback(async () => {
    await finishDaemonRegistration({
      registration,
      infoPath,
      logPath,
      close: { retainRegistration: false, unfinished: ['Daemon startup rolled back.'] },
    });
  });
  const startupPhasesPath = resolveDaemonStartupPhasesPath(baseDir, process.pid);
  const recordStartupPhase = (phase: Parameters<typeof recordDaemonStartupMarker>[1]): void =>
    recordDaemonStartupMarker(startupPhasesPath, phase, (error) => {
      stderr.write(`Daemon startup marker write failed: ${error.message}\n`);
    });
  recordStartupPhase('lock-acquired');

  rollback.onRollback(() => {
    stopMetadataLossWatch();
  });
  const startupDiagnostics: ResourceDiagnostic[] = [];
  await deps.ownerLifecycle.configureForDaemonLock({
    stateDir: baseDir,
    hasDeviceClaimAuthority: (device) => processOwnsActiveDeviceClaim(device, env),
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
  recordStartupPhase('recovery-finished');
  const { openDaemonServers, reconcileDeviceClaimsForDaemonStartup } =
    await import('./server-startup.ts');
  const { servers, socketPort, httpPort } = await openDaemonServers(
    daemonServerMode,
    {
      handleRequest,
      leaseRegistry,
      endSessionsForLease: async (leaseId) => await endSessionsForLease(leaseId, 'LEASE_RELEASED'),
      token,
      retainArtifacts,
      env,
      cwd: host.cwd,
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
    },
    rollback,
  );
  recordStartupPhase('listening');
  publishDaemonInfo(socketPort, httpPort);
  recordStartupPhase('registered');
  removeDaemonStartupPhasesFile(startupPhasesPath);
  stopMetadataLossWatch = armDaemonMetadataLossWatch(baseDir, infoPath, logPath, daemonIdentity);
  await flushDaemonStartupDiagnostics(logPath, startupDiagnostics);
  for (const plugin of deps.pluginInventory.filter(({ state }) => state === 'failed')) {
    await emitDaemonDiagnostic(logPath, 'provider_plugin_failed', {
      provider: plugin.provider,
      package: plugin.package,
      source: plugin.source,
      code: plugin.error?.code,
      reason: plugin.error?.reason,
      message: plugin.error?.message,
      hint: plugin.error?.hint,
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
    env,
  );
  // Arms the initial idle-reap timer: a daemon that starts and never
  // receives a request must still be able to reap itself.
  idleReap.noteActivity();
  // The #2833 deadline needs no equivalent arm: the store is empty until a request puts a session
  // in it, and that request's own completion re-arms the reaper.

  // Spawn the PNG worker ahead of the first screenshot request so its
  // cold-start cost is not paid on a user-visible call. Best effort: when it
  // cannot start or later stops, PNG processing falls back to the in-process sync path and the
  // daemon log records why, once, outside any request.
  const releasePngWorker = retainPngWorker((reason) => {
    void emitDaemonDiagnostic(logPath, 'png_worker_unavailable', {
      reason: reason.kind,
      detail: reason.detail,
    }).catch(() => {});
  });

  let abandonedRequests = 0;
  let platformOwnersPending = true;
  const hasUnfinishedWork = () => abandonedRequests > 0 || platformOwnersPending;
  let shutdownOutcome: Parameters<DaemonRegistrationOwner['finish']>[0];
  const drainInFlightRequests = async (): Promise<ShutdownReport['requests']> => {
    const total = inFlightRequests.size;
    if (total === 0) return { drained: 0, abandoned: 0 };
    cancelAllRequests();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      Promise.allSettled(inFlightRequests).then(() => 'drained' as const),
      new Promise<'deadline'>((resolve) => {
        deadlineTimer = setTimeout(() => resolve('deadline'), requestDrainTimeoutMs);
      }),
    ]);
    clearTimeout(deadlineTimer);
    abandonedRequests = outcome === 'drained' ? 0 : inFlightRequests.size;
    if (abandonedRequests > 0) {
      await emitDaemonDiagnostic(logPath, 'daemon_shutdown_requests_abandoned', {
        abandoned: abandonedRequests,
        budgetMs: requestDrainTimeoutMs,
      });
    }
    return { drained: total - abandonedRequests, abandoned: abandonedRequests };
  };

  const closeSteps = async (closeOptions: { cause?: unknown }): Promise<ShutdownReport> => {
    idleReap.cancel();
    sessionIdleExpiry.cancel();
    leaseSessionEnd.cancel();
    clearInterval(leaseExpirySweep);
    shuttingDown = true;
    stopMetadataLossWatch();
    // Cancellation and the listener close run together: a connection held by a request that ignores
    // cancellation is force-closed at the same budget the drain gives it.
    const serversClosed = closeDaemonServers(servers, requestDrainTimeoutMs);
    if (closeOptions.cause) await emitFatalDiagnostic(closeOptions.cause);
    const requests = await drainInFlightRequests();
    await serversClosed;
    await leaseSessionEnd.drain();
    // Hand healthy runners off before durable session teardown. The lifecycle gateway later
    // terminates only still-owned generations once all resources have finalized.
    //
    // The scope is what makes this step observable: a SIGTERM shutdown has no request, and therefore
    // no diagnostics scope, so `emitDiagnostic` would drop every detach reason. Daemon debug level is
    // forced on here because the declines are the point of the record — a handoff that silently
    // skipped is indistinguishable from a rebuild (#2681).
    let handedOffRunners: readonly string[] = [];
    try {
      await withDaemonDiagnosticsScope({ logPath }, async () => {
        handedOffRunners = await applicationLifecycle.detachForDaemonShutdown();
      });
    } catch {}
    expiredProviderLeaseReleaser.beginShutdown();
    const sessions = await teardownDaemonSessions();
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
    const ownerClose = await settleWithinBudget(
      () => deviceRuntimeGateway.shutdown(),
      options.shutdownBudgets?.ownerMs ?? DAEMON_PLATFORM_OWNER_SHUTDOWN_TIMEOUT_MS,
    );
    if (ownerClose.kind === 'rejected') throw ownerClose.error;
    platformOwnersPending = ownerClose.kind === 'deadline';
    const plugins = await pluginClose.close();
    for (const failure of plugins.failed) {
      await emitDaemonDiagnostic(logPath, 'provider_plugin_cleanup_failed', {
        provider: failure.provider,
        source: failure.source,
        [failure.step]: failure.error,
      });
    }
    const stoppedRunners = await applicationLifecycle.finalizeDaemonShutdown();
    const unknownLeaseIds = new Set(providerReleaseDrain.unknown.map((lease) => lease.leaseId));
    const report: ShutdownReport = {
      providerReleases: {
        completed: providerReleaseDrain.released.map((lease) => lease.leaseId),
        pending: providerReleaseDrain.pending
          .filter((lease) => !unknownLeaseIds.has(lease.leaseId))
          .map((lease) => lease.leaseId),
        unknown: [...unknownLeaseIds],
      },
      requests,
      platformOwners: platformOwnersPending ? 'pending' : 'closed',
      runners: { stopped: [...stoppedRunners], handedOff: [...handedOffRunners] },
      sessions,
      plugins,
    };
    shutdownOutcome = {
      providerReleases: providerReleaseDrain,
      claims: shutdownClaimLedger.claims,
    };
    return report;
  };

  const closeOnHost = async (closeOptions: { cause?: unknown }): Promise<ShutdownReport> => {
    let report: ShutdownReport | undefined;
    try {
      report = await closeSteps(closeOptions);
      return report;
    } finally {
      await Promise.allSettled([
        Promise.race([
          Promise.resolve().then(releasePngWorker),
          sleep(DAEMON_PNG_WORKER_TERMINATE_TIMEOUT_MS),
        ]),
        Promise.resolve().then(() => pluginClose.close()),
      ]);
      await Promise.allSettled([
        finishDaemonRegistration({
          registration,
          infoPath,
          logPath,
          outcome: shutdownOutcome,
          close: {
            retainRegistration: hasUnfinishedWork(),
            unfinished: report
              ? describeUnfinishedShutdownWork(report)
              : ['Daemon shutdown: a close step failed, so the runtime did not finish leaving.'],
          },
        }),
      ]);
      if (!hasUnfinishedWork()) {
        try {
          await deps.ownerLifecycle.clearDaemonLockConfiguration();
        } catch {}
        runtimeState.dispose();
      }
    }
  };

  // Idle reap, external callers and the executable's signal handlers all close through here, and
  // none of them runs inside the startup scope, so the close re-enters it.
  let closing: Promise<ShutdownReport> | undefined;
  let settleClosed: { resolve(report: ShutdownReport): void; reject(error: unknown): void };
  const closed = new Promise<ShutdownReport>((resolve, reject) => {
    settleClosed = { resolve, reject };
  });
  // A close nobody awaits (an idle reap) still reports through `closed`, which must not become an
  // unhandled rejection when no caller observes it.
  closed.catch(() => {});
  const close = (closeOptions: { cause?: unknown } = {}): Promise<ShutdownReport> => {
    if (!closing) {
      closing = runtimeState.run(() =>
        withCommandHost(
          { host, requestEnv: undefined },
          async () => await closeOnHost(closeOptions),
        ),
      );
      closing.then(settleClosed.resolve, settleClosed.reject);
    }
    return closing;
  };

  startingUp = false;

  return {
    httpPort,
    close,
    closed,
    run: runtimeState.run,
    socketPort,
    token,
  };
}
