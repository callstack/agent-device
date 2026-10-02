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
import {
  resolveRunnerHandoffTarget,
  type RunnerHandoffLane,
  type RunnerHandoffRefusal,
} from './apple-runner-platform.ts';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import type { AppleRunnerLifecycleOptions } from './runner-provider.ts';
import { flushRunnerLogAppends, getFreePort, resolveRunnerLaunchLogPath } from './runner-io.ts';
import { RUNNER_STARTUP_TIMEOUT_MS } from './runner-startup-transport.ts';
import {
  createRunnerPhaseBudget,
  ensureXctestrunArtifact,
  IOS_RUNNER_CONTAINER_BUNDLE_IDS,
  prepareXctestrunWithEnv,
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  type RunnerPhaseBudget,
} from './runner-xctestrun.ts';
import { resolveRunnerCacheKey } from './runner-cache-metadata.ts';
import type { RunnerCommand } from './runner-contract.ts';
import { enrichRunnerStartupFailureWithDeviceStates } from './runner-error-classification.ts';
import { isRunnerReadinessProbeCommand } from './runner-command-traits.ts';
import {
  buildDetachedRunnerLease,
  buildRunnerLease,
  prepareRunnerLeaseForStartup,
  runnerOwnerToken,
  withRunnerLeaseLock,
  writeRunnerLease,
} from './runner-lease.ts';
import { isIosRunnerDetachEnabled, tryAdoptRunnerSessionFromLease } from './runner-adoption.ts';
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
  advanceRunnerSessionState,
  buildRunnerSessionId,
  canWorkWithRunnerSession,
  isRunnerMainThreadOccupied,
  normalizeRunnerStartupTimeoutMs,
  resolveRunnerDetachDecision,
  resolveRunnerSessionLiveness,
  RunnerCommandAccounting,
  type RunnerDetachRefusal,
  type RunnerSession,
  type RunnerSessionLiveness,
  type RunnerSessionRegistration,
} from './runner-session-types.ts';
import { launchRunnerProcess, type LaunchedRunnerProcess } from './runner-process-launch.ts';
import { isSameRunnerSimulator } from './runner-device-set.ts';
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
  const start = withRunnerSessionLock(device.id, async () => {
    const { openRunnerStartBudget } = await import('./runner-start-budget.ts');
    // One budget for the whole start, opened once the lock is held so a start queued behind
    // another does not spend its clock waiting: the reuse check's toolchain probes, adoption and
    // the startup itself all read it. The request's cancellation rides with it, so a client
    // disconnect kills the blocking xctestrun build and runner launch (killProcessTree via exec)
    // instead of orphaning them; a caller's own deadline does not, so the start it interrupts is
    // still there for the retry (#2894). A start that outlives its caller is still bounded: once
    // the budget is spent the same signal ends it, the lock is released and the device is usable.
    const budget = openRunnerStartBudget(options);
    try {
      const existing = runnerSessions.get(device.id);
      if (existing) {
        assertExpectedRunnerSession(existing, options.expectedRunnerSessionId);
        const reusable = await resolveReusableRunnerSession(device, existing, budget.phase);
        if (reusable) return reusable;
      }

      return await withRunnerLeaseLock(
        device.id,
        async () => await startRunnerSessionWithLease(device, options, budget),
      );
    } catch (error) {
      throw budget.exhausted.aborted ? budget.exhausted.reason : error;
    } finally {
      budget.close();
    }
  });
  const { raceRunnerStartAgainstCaller } = await import('./runner-start-budget.ts');
  return await raceRunnerStartAgainstCaller(start, options.signal);
}

/** How long the device-readiness probe may take, bounded by the startup budget it runs inside. */
const RUNNER_DEVICE_READINESS_BUDGET_MS = 10_000;

async function startRunnerSessionWithLease(
  device: DeviceInfo,
  options: RunnerSessionOptions,
  budget: RunnerStartBudget,
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
  cancelIosRunnerIdleStop(deviceId);
  await withRunnerSessionLock(deviceId, async () => {
    await withRunnerLeaseLock(deviceId, async () => {
      await stopRunnerSessionInternal(deviceId, undefined, { leaseLockHeld: true });
      await cleanupOwnedIosRunnerLease(deviceId);
    });
  });
}

/**
 * Releases a runner at session close, preferring warm reuse only when the runner is actually
 * reusable. A non-retained close, or a retained close over a runner whose last exchange reported
 * main-thread work still draining, stops it now: a busy runner refuses every command until it drains
 * or wedges, so pooling it back hands the same stalled process to the next `open` (#2552). An idle
 * retained runner keeps warm reuse via the idle-stop timer. The decision is owned here because the
 * occupancy fact lives on the session, and awaited so `close` returns only once the lease is gone.
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
  await stopIosRunnerSession(deviceId);
}

export async function abortAllIosRunnerSessions(): Promise<void> {
  const activeSessions = Array.from(runnerSessions.values());
  await abortRunnerSessionsAndPrepProcesses(activeSessions);
  for (const session of activeSessions) {
    if (runnerSessions.get(session.deviceId) === session) {
      runnerSessions.delete(session.deviceId);
    }
  }
}

type RunnerDetachSkippedReason =
  | RunnerHandoffRefusal
  | RunnerDetachRefusal
  | 'lease_absent'
  | 'runner_process_dead'
  | 'lease_write_failed';

// Graceful daemon shutdown hands a request-proven runner off to the next daemon instead of paying
// the xcodebuild ramp again: the lease token is rewritten to a detached form (so this daemon's own
// teardown paths no longer classify it as owned), this process gives up its sides of the runner's
// log, and the session simply leaves the in-memory map. Once this process exits the lease is stale
// and the adoption path picks it up. Explicit cleanup still works: clean:daemon kills by the lease's
// runnerPid, and the runner's XCTWaiter self-expires after 24h.
//
// Every gate that keeps a session on the kill path is named and reported, because a handoff that
// silently declines is indistinguishable from a rebuild: the handoff lanes
// (`resolveRunnerHandoffTarget`), a session that never served a command, still owes a response, or
// last reported main-thread work still draining (`resolveRunnerDetachDecision`), a missing or
// unwritable lease, and a runner this process cannot prove alive. What stays in the map is torn down by `stopAllIosRunnerSessions`, which the daemon's
// shutdown runs right after this — so a shutdown during a startup tears that runner down rather than
// handing off one that never reached its listener (#2681).
export async function detachIosRunnerSessionsForShutdown(): Promise<number> {
  if (!isIosRunnerDetachEnabled()) return 0;
  let detached = 0;
  for (const [deviceId, session] of runnerSessions) {
    const outcome = detachRunnerSessionForShutdown(deviceId, session);
    if (!outcome.detached) {
      emitDiagnostic({
        level: 'debug',
        phase: 'ios_runner_session_detach_skipped',
        data: {
          deviceId,
          sessionId: session.sessionId,
          lane: outcome.lane,
          reason: outcome.reason,
          // A refused handoff is read from the daemon log, and the two refusals that name a charge look
          // identical without this: an exchange still awaited is recovered by its own answer, while an
          // abandoned residue waits for terminal evidence for its `commandId` (#2965).
          outstandingCharges: session.commandCharges.outstandingChargeCount,
          hasAbandonedCharges: session.commandCharges.hasAbandonedCharges,
        },
      });
      continue;
    }
    detached += 1;
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_session_detached',
      data: {
        deviceId,
        lane: outcome.lane,
        sessionId: session.sessionId,
        runnerPid: session.child.pid,
        port: session.port,
        runnerLogPath: session.runnerLogPath,
      },
    });
  }
  return detached;
}

type RunnerDetachOutcome =
  | { detached: true; lane: RunnerHandoffLane }
  | { detached: false; lane: RunnerHandoffLane | undefined; reason: RunnerDetachSkippedReason };

function detachRunnerSessionForShutdown(
  deviceId: string,
  session: RunnerSession,
): RunnerDetachOutcome {
  const target = resolveRunnerHandoffTarget(session.device);
  if (!target.handoff) {
    return { detached: false, lane: undefined, reason: target.reason };
  }
  const lane = target.lane;
  const decision = resolveRunnerDetachDecision(session);
  if (!decision.detach) {
    return { detached: false, lane, reason: decision.reason };
  }
  const lease = session.lease;
  if (!lease) {
    return { detached: false, lane, reason: 'lease_absent' };
  }
  if (!isRunnerProcessAlive(session.child.pid)) {
    return { detached: false, lane, reason: 'runner_process_dead' };
  }
  try {
    writeRunnerLease(buildDetachedRunnerLease(lease));
  } catch {
    return { detached: false, lane, reason: 'lease_write_failed' };
  }
  // Only once the lease says the runner is handed over does this process give up its own sides of
  // the runner's log: until that write lands the session is still owned, and an owned session that
  // stopped following its runner's output is worse off than one that never handed anything off.
  // The runner holds its own descriptor, so this cannot disturb it either way (#2681).
  session.endOutputObservation?.();
  runnerSessions.delete(deviceId);
  cancelIosRunnerIdleStop(deviceId);
  advanceRunnerSessionState(session, 'stopped');
  return { detached: true, lane };
}

export async function stopAllIosRunnerSessions(): Promise<void> {
  await abortAllIosRunnerSessions();
  const pending = Array.from(runnerSessions.keys());
  await Promise.allSettled(
    pending.map(async (deviceId) => {
      await stopIosRunnerSession(deviceId);
    }),
  );
  await stopRunnerPrepProcesses();
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
