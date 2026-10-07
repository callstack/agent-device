import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  withKeyedLock,
  Deadline,
  emitRequestProgress,
  emitDiagnostic,
  buildSimctlArgsForDevice,
  runXcrun,
} from './host.ts';
import type { ExecResult } from '@agent-device/host-kit/command';
import { isApplePlatform, type DeviceInfo } from '@agent-device/kernel/device';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { AppleRunnerLifecycleOptions } from './runner-provider.ts';
import { flushRunnerLogAppends, getFreePort, resolveRunnerLaunchLogPath } from './runner-io.ts';
import { RUNNER_STARTUP_TIMEOUT_MS } from './runner-startup-transport.ts';
import {
  assertRunnerStartAdmitsPreparation,
  createRunnerPhaseBudget,
  ensureXctestrunArtifact,
  fenceRunnerStartAdmissionsForTeardown,
  finishRunnerStartAdmission,
  IOS_RUNNER_CONTAINER_BUNDLE_IDS,
  openRunnerStartAdmission,
  prepareXctestrunWithEnv,
  readmitRunnerStartAdmission,
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  retireAllRunnerStartAdmissions,
  runnerStartAdmitsPreparation,
  runnerStartRetiredError,
  type RunnerPhaseBudget,
  type RunnerStartAdmission,
} from './runner-xctestrun.ts';
import { resolveRunnerCacheKey } from './runner-cache-metadata.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { enrichRunnerStartupFailureWithDeviceStates } from './runner-error-classification.ts';
import { isRunnerReadinessProbeCommand } from './runner-command-traits.ts';
import {
  buildRunnerLease,
  prepareRunnerLeaseForStartup,
  runnerOwnerToken,
  withRunnerLeaseLock,
  writeRunnerLease,
} from './runner-lease.ts';
import {
  detachRunnerSessionsForShutdown,
  tryAdoptRunnerSessionFromLease,
} from './runner-adoption.ts';
import { buildRunnerSessionXctestrunSuffix } from './runner-artifact-env.ts';
import {
  abortRunnerSessionsAndPrepProcesses,
  cleanupOwnedIosRunnerLease,
  disposeRunnerSession,
  isRunnerProcessAlive,
  runnerLeaseCleanupAdapter,
  RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
  stopRunnerPrepProcesses,
  type RunnerDisposalOptions,
} from './runner-disposal.ts';
import {
  buildRunnerSessionId,
  canWorkWithRunnerSession,
  isRunnerMainThreadOccupied,
  normalizeRunnerStartupTimeoutMs,
  resolveRunnerSessionLiveness,
  RunnerCommandAccounting,
  type RunnerSession,
  type RunnerSessionLiveness,
  type RunnerSessionRegistration,
} from './runner-session-types.ts';
import { launchRunnerProcess, type LaunchedRunnerProcess } from './runner-process-launch.ts';
import { isSameRunnerSimulator } from './runner-device-set.ts';
// The start-budget members are read through function-scoped imports: this module sits in the
// façade closures the eager-closure budget holds at its merge-base size, and the budget module is
// only ever needed at a start, never on an import path.
import type { RunnerStartBudget } from './runner-start-budget.ts';

export type { RunnerSession } from './runner-session-types.ts';

export type RunnerSessionOptions = AppleRunnerLifecycleOptions;

const runnerSessions = new Map<string, RunnerSession>();
const runnerSessionLocks = new Map<string, Promise<unknown>>();
const runnerIdleStopTimers = new Map<string, NodeJS.Timeout>();
const RUNNER_RETAINED_IDLE_STOP_DEFAULT_MS = 5 * 60_000;
const RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS = 10_000;

function withRunnerSessionLock<T>(deviceId: string, task: () => Promise<T>): Promise<T> {
  return withKeyedLock(runnerSessionLocks, deviceId, task);
}

export async function ensureRunnerSession(
  device: DeviceInfo,
  options: RunnerSessionOptions,
): Promise<RunnerSession> {
  // Any runner use means the device is active again: a pending idle stop
  // from a retained-after-close runner no longer applies.
  cancelIosRunnerIdleStop(device.id);
  // This start's admission: the loop that owns the start across retries supplies one, and every
  // other start takes a token for itself. Both are taken synchronously, before the first await and
  // registered with the device, so a teardown beginning in this same turn closes it even while
  // this start queues behind the work another start holds the session lock for (#3220).
  const ownedAdmission = options.startAdmission;
  const startAdmission = ownedAdmission ?? openRunnerStartAdmission(device.id);
  const start = withRunnerSessionLock(device.id, async () => {
    const { openRunnerStartBudget, reserveRunnerStartOwnerInterest } =
      await import('./runner-start-budget.ts');
    // A start woken after the close that closed its admission has settled did no work under the
    // fence and runs on as the fresh start it always was; one woken WHILE that close still runs
    // is refused here, before it adopts, boots, or builds (#3220).
    readmitRunnerStartAdmission(startAdmission);
    assertRunnerStartAdmitsPreparation(device.id, startAdmission);
    // One budget for the whole start, opened once the lock is held so a start queued behind
    // another does not spend its clock waiting: the reuse check's toolchain probes, adoption and
    // the startup itself all read it. The request's cancellation rides with it, so a client
    // disconnect kills the blocking xctestrun build and runner launch (killProcessTree via exec)
    // instead of orphaning them; a caller's own deadline does not, so the start it interrupts is
    // still there for the retry (#2894). A start that outlives its caller is still bounded: once
    // the budget is spent the same signal ends it, the lock is released and the device is usable.
    const budget = openRunnerStartBudget(options);
    // The starting request counts as interested even on the surface that passes no `signal`, so
    // a joiner's cancellation can never outvote the live owner and stop its build (#3220).
    const releaseOwnerInterest = reserveRunnerStartOwnerInterest(startAdmission, options);
    try {
      const existing = runnerSessions.get(device.id);
      if (existing) {
        assertExpectedRunnerSession(existing, options.expectedRunnerSessionId);
        const reusable = await resolveReusableRunnerSession(device, existing, budget.phase);
        if (reusable) return reusable;
      }

      return await withRunnerLeaseLock(
        device.id,
        async () => await startRunnerSessionWithLease(device, options, budget, startAdmission),
      );
    } catch (error) {
      throw budget.exhausted.aborted ? budget.exhausted.reason : error;
    } finally {
      budget.close();
      releaseOwnerInterest();
    }
  });
  const { raceRunnerStartAgainstCaller } = await import('./runner-start-budget.ts');
  return await raceRunnerStartAgainstCaller(
    // A start that minted its own token releases it; a loop-supplied token belongs to the loop,
    // which finishes it when the loop itself is done retrying (#3220).
    ownedAdmission ? start : start.finally(() => finishRunnerStartAdmission(startAdmission)),
    startAdmission,
    options.signal,
  );
}

/** How long the device-readiness probe may take, bounded by the startup budget it runs inside. */
const RUNNER_DEVICE_READINESS_BUDGET_MS = 10_000;

async function startRunnerSessionWithLease(
  device: DeviceInfo,
  options: RunnerSessionOptions,
  budget: RunnerStartBudget,
  startAdmission: RunnerStartAdmission,
): Promise<RunnerSession> {
  const startupTimings: Record<string, number> = {};
  const startupBudget = budget.phase;
  const signal = startupBudget.signal;
  const logicalLeaseContext = normalizeRunnerLogicalLeaseContext(
    options.runnerLeaseContext,
    device.id,
  );
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_session_startup',
    data: {
      deviceId: device.id,
      logicalLeaseContext,
    },
  });
  const adopted = await measureRunnerStartupStep(
    startupTimings,
    'adopt_detached_runner',
    async () =>
      await tryAdoptRunnerSessionFromLease(device, {
        budget: startupBudget,
        expectedRunnerSessionId: options.expectedRunnerSessionId,
      }),
  );
  if (adopted) {
    adopted.startupTimings = startupTimings;
    adopted.logicalLeaseContext = logicalLeaseContext;
    // An adoption publishes a runner exactly the way a build does, so it answers to the same
    // gate: a start fenced by a teardown registers its runner into no device (#3220). The
    // runner itself keeps its lease for the next open to adopt.
    assertRunnerStartAdmitsPreparation(device.id, startAdmission);
    runnerSessions.set(device.id, adopted);
    return adopted;
  }
  assertRunnerSessionMayStart(options.expectedRunnerSessionId);
  await measureRunnerStartupStep(startupTimings, 'cleanup_stale_xcodebuild', async () => {
    await prepareRunnerLeaseForStartup(device, runnerLeaseCleanupAdapter, logicalLeaseContext);
  });
  await measureRunnerStartupStep(startupTimings, 'ensure_booted', async () => {
    await ensureBootedIfNeeded(device);
  });
  // Device first, host second: both answers can be wrong at once, and the phone's own state is the
  // one the caller can act on without admin rights. Probing the host first would publish only the
  // Mac's reason and hide the device's (#2683).
  // Only a disabled Developer Mode toggle stops the run here; whatever else the device reports rides
  // along onto the build below, because iOS 17+ mounts the developer disk image on demand during
  // build and launch and refusing that state up front would refuse a state this build clears (#2683).
  const deviceStates = await measureRunnerStartupStep(
    startupTimings,
    'verify_device_readiness',
    async () =>
      await (
        await import('./runner-device-readiness.ts')
      ).preflightIosRunnerDeviceReadiness(device, {
        budgetMs: Math.min(
          RUNNER_DEVICE_READINESS_BUDGET_MS,
          startupBudget.deadline?.remainingMs() ?? RUNNER_DEVICE_READINESS_BUDGET_MS,
        ),
        signal,
      }),
  );
  await measureRunnerStartupStep(startupTimings, 'verify_host_dev_tools_security', async () => {
    // Loaded here for the same reason as the device probe above.
    const { assertDevToolsSecurityForIosRunner } = await import('./runner-dev-tools-security.ts');
    await assertDevToolsSecurityForIosRunner(device);
  });
  if (options.cleanStaleBundles) {
    await measureRunnerStartupStep(startupTimings, 'cleanup_stale_bundles', async () => {
      await cleanupStaleSimulatorRunnerBundles(device);
    });
  } else {
    startupTimings.cleanup_stale_bundles = 0;
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_startup_cleanup_stale_bundles_skipped',
    });
  }
  let xctestrunArtifact: Awaited<ReturnType<typeof ensureXctestrunArtifact>>;
  let port: number;
  let xctestrunPath: string;
  let jsonPath: string;
  const runnerLogPath = resolveRunnerLaunchLogPath(options.logPath, device.id);
  let runnerProcess: LaunchedRunnerProcess;
  // One catch for everything between here and a runner that answers, because the device's own answer
  // belongs on all of it (#2690 review): a cold build, a warm derived cache that fails at install, and
  // an external xctestrun that never launches are different steps, and a caller told "developer disk
  // image" should not have to know which one this run happened to take.
  try {
    xctestrunArtifact = await measureRunnerStartupStep(
      startupTimings,
      'ensure_xctestrun',
      async () =>
        await ensureXctestrunArtifact(device, {
          ...options,
          startAdmission,
          budget: createRunnerPhaseBudget(resolveRunnerBuildTimeoutMs(options, budget), signal),
        }),
    );
    startupTimings.build_xctestrun = xctestrunArtifact.buildMs;
    port = await measureRunnerStartupStep(
      startupTimings,
      'allocate_port',
      async () => await getFreePort(),
    );
    ({ xctestrunPath, jsonPath } = await measureRunnerStartupStep(
      startupTimings,
      'prepare_xctestrun_env',
      async () =>
        await prepareXctestrunWithEnv(
          xctestrunArtifact.xctestrunPath,
          { AGENT_DEVICE_RUNNER_PORT: String(port) },
          buildRunnerSessionXctestrunSuffix({
            deviceId: device.id,
            ownerToken: runnerOwnerToken(),
            port,
          }),
          { iosXctestEnvDir: options.iosXctestEnvDir },
        ),
    ));
    if (xctestrunArtifact.buildMs > 0) {
      emitRequestProgress({
        type: 'command',
        status: 'progress',
        message: 'Starting XCTest runner...',
      });
    }
    runnerProcess = await measureRunnerStartupStep(
      startupTimings,
      'launch_xcodebuild',
      async () => {
        // Build output reaches this same file through an async append queue, so the offset that marks
        // where this generation's output starts is only trustworthy once those bytes have landed below
        // it; otherwise a queued build line reads as the runner's own failure output (#2681).
        await flushRunnerLogAppends(runnerLogPath).catch(() => {});
        return await launchRunnerProcess({
          device,
          port,
          xctestrunPath,
          derivedPath: xctestrunArtifact.derived,
          signal,
          logPath: runnerLogPath,
          traceLogPath: options.traceLogPath,
          verbose: options.verbose,
        });
      },
    );
  } catch (error) {
    throw enrichRunnerStartupFailureWithDeviceStates(error, deviceStates);
  }
  const sessionId = buildRunnerSessionId(device.id, port);
  const lease = buildRunnerLease({
    device,
    sessionId,
    runnerPid: runnerProcess.child.pid,
    port,
    xctestrunPath,
    cacheKey: xctestrunArtifact.cacheKey,
    jsonPath,
    runnerLogPath,
  });
  const session: RunnerSession = {
    sessionId,
    device,
    deviceId: device.id,
    port,
    xctestrunPath,
    xctestrunArtifact,
    jsonPath,
    runnerLogPath,
    testPromise: runnerProcess.wait,
    child: runnerProcess.child,
    endOutputObservation: runnerProcess.endOutputObservation,
    readLogTail: runnerProcess.readLogTail,
    state: 'starting',
    commandCharges: new RunnerCommandAccounting(),
    startupRetryWake: runnerProcess.startupRetryWake,
    launchDeadline: Deadline.fromTimeoutMs(resolveRunnerLaunchReadinessMs(budget)),
    startupTimings,
    startupDeviceStates: deviceStates,
    logicalLeaseContext,
    lease,
    speculative: options.speculative === true,
  };
  if (signal?.aborted) {
    await disposeRunnerSession(session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      leaseLockHeld: true,
    });
    throw createRequestCanceledError();
  }
  // Publication is the second gate: a start whose preparation was admitted before a teardown
  // must not register a runner into the device that teardown is settling, or into the fresh
  // start a later open has already begun (#3220).
  await refuseRetiredRunnerPublication(device, session, startAdmission);
  try {
    writeRunnerLease(lease);
  } catch (error) {
    await stopRunnerSessionInternal(device.id, session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      leaseLockHeld: true,
    });
    throw error;
  }
  runnerSessions.set(device.id, session);
  return session;
}

/**
 * Refuses a launched runner whose start lost admission while it was building: the publication
 * a fenced start would make lands on a device teardown is settling or a fresh start already
 * owns, so the launch this start already paid for is its own to stop, and it stops it under
 * the lease lock the start still holds (#3220).
 */
async function refuseRetiredRunnerPublication(
  device: DeviceInfo,
  session: RunnerSession,
  startAdmission: RunnerStartAdmission,
): Promise<void> {
  if (runnerStartAdmitsPreparation(device.id, startAdmission)) return;
  await disposeRunnerSession(session, {
    graceful: false,
    waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
    leaseLockHeld: true,
  });
  throw runnerStartRetiredError(startAdmission.retired ?? 'device_teardown');
}

export function assertExpectedRunnerSession(
  session: Pick<RunnerSession, 'sessionId'>,
  expectedRunnerSessionId: string | undefined,
): void {
  if (expectedRunnerSessionId !== undefined && session.sessionId !== expectedRunnerSessionId) {
    throw runnerSessionOwnershipChanged();
  }
}

function assertRunnerSessionMayStart(expectedRunnerSessionId: string | undefined): void {
  if (expectedRunnerSessionId !== undefined) throw runnerSessionOwnershipChanged();
}

function runnerSessionOwnershipChanged(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Apple runner session ownership changed before command dispatch',
    { reason: 'runner_session_ownership_changed' },
  );
}

/** Whether a registered session can serve this device; one that cannot is stopped when it must be. */
async function isRunnerSessionServing(
  device: DeviceInfo,
  existing: RunnerSession,
): Promise<boolean> {
  const liveness = readRunnerSessionLivenessFor(existing);
  if (liveness === 'gone') {
    await measureRunnerStartupStep({}, 'stop_stale_session', async () => {
      await stopRunnerSessionInternal(device.id, existing, {
        graceful: false,
        waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      });
    });
    return false;
  }
  // A registered session already being taken down or already handed off is not usable, even when
  // its runner process is still there for a moment while disposal works.
  if (liveness !== 'starting' && liveness !== 'ready') return false;
  if (liveness === 'starting' && existing.launchDeadline?.isExpired()) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_session_invalidated',
      data: {
        deviceId: device.id,
        sessionId: existing.sessionId,
        reason: 'runner_launch_budget_exhausted',
      },
    });
    await measureRunnerStartupStep({}, 'stop_expired_starting_session', async () => {
      await stopRunnerSessionInternal(device.id, existing, {
        graceful: false,
        waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      });
    });
    return false;
  }
  if (isSameRunnerSimulator(existing.device, device)) return true;
  await measureRunnerStartupStep({}, 'stop_other_simulator_set_session', async () => {
    await stopRunnerSessionInternal(device.id, existing);
  });
  return false;
}

async function resolveReusableRunnerSession(
  device: DeviceInfo,
  existing: RunnerSession,
  startupBudget: RunnerPhaseBudget,
): Promise<RunnerSession | null> {
  if (!(await isRunnerSessionServing(device, existing))) return null;

  const existingArtifact = existing.xctestrunArtifact;
  if (existingArtifact?.cache === 'external') {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_session_reuse',
      data: {
        deviceId: device.id,
        sessionId: existing.sessionId,
        ready: existing.state === 'ready',
        cache: existingArtifact.cache,
        logicalLeaseContext: existing.logicalLeaseContext,
      },
    });
    return existing;
  }

  const expectedMetadata = resolveExpectedRunnerCacheMetadata(device, undefined, startupBudget);
  const expectedDerived = resolveRunnerDerivedPath(device, expectedMetadata);
  const expectedCacheKey = resolveRunnerCacheKey(expectedMetadata);
  if (
    existingArtifact?.derived !== expectedDerived ||
    existingArtifact.cacheKey !== expectedCacheKey
  ) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_session_artifact_stale',
      data: {
        deviceId: device.id,
        sessionId: existing.sessionId,
        currentDerived: existingArtifact?.derived,
        expectedDerived,
        currentCacheKey: existingArtifact?.cacheKey,
        expectedCacheKey,
      },
    });
    await measureRunnerStartupStep({}, 'stop_stale_artifact_session', async () => {
      await stopRunnerSessionInternal(device.id, existing);
    });
    return null;
  }

  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_session_reuse',
    data: {
      deviceId: device.id,
      sessionId: existing.sessionId,
      ready: existing.state === 'ready',
      logicalLeaseContext: existing.logicalLeaseContext,
    },
  });
  return existing;
}

async function cleanupStaleSimulatorRunnerBundles(device: DeviceInfo): Promise<void> {
  if (device.kind !== 'simulator') {
    return;
  }

  await Promise.allSettled(
    IOS_RUNNER_CONTAINER_BUNDLE_IDS.map(async (bundleId) => {
      const result = await uninstallStaleSimulatorRunnerBundle(device, bundleId);
      if (!result || isBenignSimulatorRunnerUninstallResult(result)) {
        return;
      }
      // Best-effort cleanup only; xcodebuild may still be able to install.
    }),
  );
}

async function uninstallStaleSimulatorRunnerBundle(
  device: DeviceInfo,
  bundleId: string,
): Promise<ExecResult | undefined> {
  try {
    return await runXcrun(buildSimctlArgsForDevice(device, ['uninstall', device.id, bundleId]), {
      allowFailure: true,
      timeoutMs: RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_startup_cleanup_stale_bundle_failed',
      data: {
        deviceId: device.id,
        bundleId,
        timeoutMs: RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

function isBenignSimulatorRunnerUninstallResult(result: ExecResult): boolean {
  if (result.exitCode === 0) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes('not installed') ||
    output.includes('found nothing') ||
    output.includes('no such file') ||
    output.includes('invalid device') ||
    output.includes('could not find')
  );
}

/**
 * The one reader of what is registered for a device: the session's state plus the one fact the
 * session cannot know itself — whether its runner process is still there. `null` means nothing is
 * registered, which is its own answer: there is no session to wait for or tear down.
 */
export function readRunnerSessionLiveness(deviceId: string): RunnerSessionRegistration | null {
  const session = runnerSessions.get(deviceId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    liveness: readRunnerSessionLivenessFor(session),
  };
}

function readRunnerSessionLivenessFor(session: RunnerSession): RunnerSessionLiveness {
  return resolveRunnerSessionLiveness({
    state: session.state,
    processRunning: isRunnerProcessAlive(session.child.pid),
  });
}

export async function invalidateRunnerSession(
  session: RunnerSession,
  reason: string,
): Promise<void> {
  await withRunnerSessionLock(session.deviceId, async () => {
    if (runnerSessions.get(session.deviceId) !== session) return;
    // A session already being torn down, or already torn down, is never disposed a second time
    // for a later reason; the reason-coded diagnostic below reports why this call was made.
    if (!canWorkWithRunnerSession(session)) return;
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_session_invalidated',
      data: {
        deviceId: session.deviceId,
        sessionId: session.sessionId,
        reason,
      },
    });
    await stopRunnerSessionInternal(session.deviceId, session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
    });
  });
}

async function stopRunnerSessionInternal(
  deviceId: string,
  sessionOverride?: RunnerSession,
  options: RunnerDisposalOptions = {},
): Promise<void> {
  const session = sessionOverride ?? runnerSessions.get(deviceId);
  if (!session) return;
  // Once disposal has begun or finished, this session has no runner to wait on; a repeat stop
  // would only re-signal a process that is already leaving and re-emit a teardown for a reason
  // that has nothing left to tear down.
  if (!canWorkWithRunnerSession(session)) return;
  await disposeRunnerSession(session, options);
  if (runnerSessions.get(deviceId) === session) {
    runnerSessions.delete(deviceId);
  }
}

// Bounds the lifetime of a runner retained after session close: the retained
// runner holds the device's runner lease, which blocks every other daemon on
// the machine from using the device. If nothing touches the runner within the
// idle window, stop it and release the lease. Any ensureRunnerSession call
// cancels the pending stop. AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS overrides
// the window; 0 disables idle stops (retain until daemon exit, the pre-idle
// behavior).
export function scheduleIosRunnerIdleStop(deviceId: string): void {
  cancelIosRunnerIdleStop(deviceId);
  const idleMs = resolveRunnerIdleStopMs();
  if (idleMs <= 0) return;
  if (!runnerSessions.has(deviceId)) return;
  const timer = setTimeout(() => {
    runnerIdleStopTimers.delete(deviceId);
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_idle_stop',
      data: { deviceId, idleMs },
    });
    stopIosRunnerSession(deviceId).catch((error: unknown) => {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_idle_stop_failed',
        data: {
          deviceId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    });
  }, idleMs);
  timer.unref?.();
  runnerIdleStopTimers.set(deviceId, timer);
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_idle_stop_scheduled',
    data: { deviceId, idleMs },
  });
}

export function cancelIosRunnerIdleStop(deviceId: string): void {
  const timer = runnerIdleStopTimers.get(deviceId);
  if (!timer) return;
  clearTimeout(timer);
  runnerIdleStopTimers.delete(deviceId);
}

function resolveRunnerIdleStopMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return RUNNER_RETAINED_IDLE_STOP_DEFAULT_MS;
}

/** The first command that is not a readiness probe makes the session the caller's, not a guess. */
export function markRunnerSessionServed(session: RunnerSession, command: RunnerCommand): void {
  if (session.speculative && !isRunnerReadinessProbeCommand(command)) {
    session.speculative = false;
  }
}

/**
 * Stops the runner a prewarm started when no command has used it yet, so a proven
 * observation-only plan retains nothing it did not ask for. A runner that served a command is
 * the session's working runner and stays under the idle-stop policy.
 */
export async function releaseSpeculativeIosRunnerSession(deviceId: string): Promise<boolean> {
  // Under the session lock: a prewarm still starting holds it and registers its session only
  // when the start completes, so the release queues behind that start instead of missing it.
  return await withRunnerSessionLock(deviceId, async () => {
    const session = runnerSessions.get(deviceId);
    if (!session?.speculative) return false;
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_speculative_released',
      data: {
        deviceId,
        sessionId: session.sessionId,
        ready: session.state === 'ready',
      },
    });
    await stopIosRunnerSession(deviceId);
    return true;
  });
}

export async function stopIosRunnerSession(deviceId: string): Promise<void> {
  await stopIosRunnerSessionDevice(deviceId);
}

/**
 * Stops the device's runner under the session lock. `fenceSettle`, when given, is called as the
 * last step INSIDE that lock, so a start queued behind this stop wakes to a device whose teardown
 * has fully settled and runs on rather than reading the still-pending fence as its own refusal.
 */
async function stopIosRunnerSessionDevice(
  deviceId: string,
  fenceSettle?: () => void,
): Promise<void> {
  cancelIosRunnerIdleStop(deviceId);
  try {
    await withRunnerSessionLock(deviceId, async () => {
      await withRunnerLeaseLock(deviceId, async () => {
        await stopRunnerSessionInternal(deviceId, undefined, { leaseLockHeld: true });
        await cleanupOwnedIosRunnerLease(deviceId);
      });
      fenceSettle?.();
    });
  } finally {
    fenceSettle?.();
  }
}

/**
 * Releases a runner at session close, preferring warm reuse only when the runner is actually
 * reusable. A non-retained close, or a retained close over a runner whose last exchange reported
 * main-thread work still draining, stops it now: a busy runner refuses every command until it drains
 * or wedges, so pooling it back hands the same stalled process to the next `open` (#2552). An idle
 * retained runner keeps warm reuse via the idle-stop timer. The decision is owned here because the
 * occupancy fact lives on the session, and awaited so `close` returns only once the lease is gone.
 * Non-retained close first fences the device's start admission, then stops the device's current
 * prep processes, before taking the session lock an in-flight cold start holds through its build:
 * a start that answers the kill by retrying its build finds the spawn refused, which is what keeps
 * close from waiting on the replacement build (#3220).
 */
export async function releaseIosRunnerOnClose(
  deviceId: string,
  options: { retain: boolean },
): Promise<void> {
  const session = runnerSessions.get(deviceId);
  if (options.retain && !isRunnerMainThreadOccupied(session)) {
    scheduleIosRunnerIdleStop(deviceId);
    return;
  }
  if (options.retain) {
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_retain_skipped_busy',
      data: { deviceId },
    });
  }
  // First the fence, then the kill: an in-flight start that answers the kill by retrying its
  // build finds admission closed and stops, and the fence outlives the kill and the session stop
  // until this close settles — while it stands, nothing prepares this device (#3220).
  const settleFence = fenceRunnerStartAdmissionsForTeardown(deviceId);
  try {
    await stopRunnerPrepProcesses(deviceId);
    await stopIosRunnerSessionDevice(deviceId, settleFence);
  } finally {
    // The error path settles too: a close that throws mid-teardown must not fence the device
    // past its own failure.
    settleFence();
  }
}

export async function abortAllIosRunnerSessions(): Promise<void> {
  // The same fence a close raises, for every device at once: the prep sweep the abort performs is
  // one-shot, so an in-flight start that would answer it with another build is refused before the
  // sweep runs, and stays refused until the sweep settles (#3220).
  const activeSessions = Array.from(runnerSessions.values());
  const settleFences = retireAllRunnerStartAdmissions(
    activeSessions.map((session) => session.deviceId),
  );
  try {
    await abortRunnerSessionsAndPrepProcesses(activeSessions);
    for (const session of activeSessions) {
      if (runnerSessions.get(session.deviceId) === session) {
        runnerSessions.delete(session.deviceId);
      }
    }
  } finally {
    // The abort settles even on its error path, so no device stays fenced past this teardown.
    settleFences();
  }
}

// The detach decision itself lives in runner-adoption.ts beside the adoption it hands off to
// (#2681); this is the map side: a detached session leaves the registry and drops its idle
// timer (the detached module gives up the log observation and marks the session stopped).
export async function detachIosRunnerSessionsForShutdown(): Promise<number> {
  return await detachRunnerSessionsForShutdown(runnerSessions, (deviceId) => {
    runnerSessions.delete(deviceId);
    cancelIosRunnerIdleStop(deviceId);
  });
}

export async function stopAllIosRunnerSessions(): Promise<void> {
  // This is the daemon's teardown: the fence spans the whole sweep, not just the abort, so a
  // start that began while the per-session stops ran meets a closed admission at its next gate
  // instead of answering the final prep sweep with another build (#3220).
  const settleFences = retireAllRunnerStartAdmissions(runnerSessions.keys());
  try {
    await abortAllIosRunnerSessions();
    const pending = Array.from(runnerSessions.keys());
    await Promise.allSettled(
      pending.map(async (deviceId) => {
        await stopIosRunnerSession(deviceId);
      }),
    );
    await stopRunnerPrepProcesses();
  } finally {
    settleFences();
  }
}

function ensureBootedIfNeeded(device: DeviceInfo): Promise<void> {
  if (device.kind !== 'simulator') {
    return Promise.resolve();
  }
  if (device.booted) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_startup_ensure_booted_skipped',
      data: { deviceId: device.id },
    });
    return Promise.resolve();
  }
  return ensureBooted(device);
}

async function ensureBooted(device: DeviceInfo): Promise<void> {
  await runXcrun(buildSimctlArgsForDevice(device, ['bootstatus', device.id, '-b']), {
    timeoutMs: RUNNER_STARTUP_TIMEOUT_MS,
  });
}

export function validateRunnerDevice(device: DeviceInfo): void {
  if (!isApplePlatform(device.platform)) {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      `Unsupported platform for iOS runner: ${device.platform}`,
    );
  }
  if (device.kind !== 'simulator' && device.kind !== 'device') {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      `Unsupported iOS device kind for runner: ${device.kind}`,
    );
  }
}

/** Run an exchange against the owned session and complete fatal invalidation before returning. */
export async function executeRunnerCommandWithSession(
  device: DeviceInfo,
  session: RunnerSession,
  command: RunnerCommand,
  logPath: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  emitRunnerStartupTimings(session, command.command);
  const { executeRunnerExchange } = await import('./runner-exchange.ts');
  return executeRunnerExchange(
    device,
    session,
    command,
    logPath,
    timeoutMs,
    (reason) => invalidateRunnerSession(session, reason),
    signal,
  );
}

/**
 * What the xctestrun build may spend: the rest of the start budget, which an explicit
 * `buildTimeoutMs` can only shorten. The build is the one step with no ceiling of its own, so a
 * start with no caller left is still ended by the clock it opened (#2894). Throws when the start
 * has nothing left, so a spent budget fails before xcodebuild is spawned.
 */
function resolveRunnerBuildTimeoutMs(
  options: RunnerSessionOptions,
  budget: RunnerStartBudget,
): number {
  const remainingMs =
    requireRunnerPhaseRemainingMs(budget.phase, 'runner_xctestrun_build') ?? budget.timeoutMs;
  const explicitMs = normalizeRunnerStartupTimeoutMs(options.buildTimeoutMs);
  return explicitMs === undefined ? remainingMs : Math.min(explicitMs, remainingMs);
}

/**
 * What the launched runner has to answer its first command, measured from launch. An explicit
 * `startupTimeoutMs` bounds the whole start, readiness included, so readiness gets what is left of
 * it. A defaulted start keeps the runner's own readiness window ({@link RUNNER_STARTUP_TIMEOUT_MS}):
 * the default budget is sized for a cold build, and a runner that never answers must not be joined
 * for the rest of it. Neither exceeds what the start budget has left.
 */
function resolveRunnerLaunchReadinessMs(budget: RunnerStartBudget): number {
  const remainingMs = Math.floor(budget.phase.deadline?.remainingMs() ?? budget.timeoutMs);
  return budget.explicit ? remainingMs : Math.min(RUNNER_STARTUP_TIMEOUT_MS, remainingMs);
}

async function measureRunnerStartupStep<T>(
  timings: Record<string, number>,
  phase: string,
  task: () => Promise<T> | T,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await task();
  } finally {
    const durationMs = Date.now() - startedAt;
    timings[phase] = durationMs;
    emitDiagnostic({
      level: 'debug',
      phase: `ios_runner_startup_${phase}`,
      durationMs,
    });
  }
}

function emitRunnerStartupTimings(session: RunnerSession, command: string): void {
  if (session.startupTimingsReported || !session.startupTimings) return;
  session.startupTimingsReported = true;
  const totalMs = Object.values(session.startupTimings).reduce((sum, value) => sum + value, 0);
  emitDiagnostic({
    level: 'info',
    phase: 'ios_runner_session_startup_timings',
    durationMs: totalMs,
    data: {
      command,
      sessionId: session.sessionId,
      ready: session.state === 'ready',
      logicalLeaseContext: session.logicalLeaseContext,
      timings: session.startupTimings,
    },
  });
}

function normalizeRunnerLogicalLeaseContext(
  context: RunnerLogicalLeaseContext | undefined,
  deviceKey: string,
): RunnerLogicalLeaseContext | undefined {
  if (!context) return undefined;
  const normalized = {
    leaseId: readOptionalContextString(context.leaseId),
    clientId: readOptionalContextString(context.clientId),
    tenantId: readOptionalContextString(context.tenantId),
    runId: readOptionalContextString(context.runId),
    leaseProvider: readOptionalContextString(context.leaseProvider),
    deviceKey: readOptionalContextString(context.deviceKey) ?? deviceKey,
  };
  const entries = Object.entries(normalized).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readOptionalContextString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
