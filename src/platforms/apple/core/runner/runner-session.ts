import { AppError, toAppErrorCode } from '../../../../kernel/errors.ts';
import {
  runCmdBackground,
  type ExecResult,
  type ExecBackgroundResult,
} from '../../../../utils/exec.ts';
import { withKeyedLock } from '../../../../utils/keyed-lock.ts';
import { Deadline } from '../../../../utils/retry.ts';
import { isIosFamily, isApplePlatform, type DeviceInfo } from '../../../../kernel/device.ts';
import type { RunnerLogicalLeaseContext } from '../../../../core/runner-lease-context.ts';
import type { AppleRunnerLifecycleOptions } from './runner-provider.ts';
import { emitRequestProgress } from '../../../../daemon/request-progress.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../../../utils/diagnostics.ts';
import { buildSimctlArgsForDevice } from '../simctl.ts';
import { runAppleToolCommand, runXcrun } from '../tool-provider.ts';
import {
  waitForRunner,
  sendRunnerCommandOnce,
  getFreePort,
  logChunk,
  RUNNER_STARTUP_TIMEOUT_MS,
  RUNNER_DESTINATION_TIMEOUT_SECONDS,
} from './runner-transport.ts';
import {
  acquireXcodebuildSimulatorSetRedirect,
  ensureXctestrunArtifact,
  IOS_RUNNER_CONTAINER_BUNDLE_IDS,
  prepareXctestrunWithEnv,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerDerivedPath,
  resolveRunnerDestination,
  resolveRunnerMaxConcurrentDestinationsFlag,
} from './runner-xctestrun.ts';
import { withRunnerCommandId, type RunnerCommand } from './runner-contract.ts';
import {
  canSkipRunnerReadinessPreflightAfterHealthyMutation,
  isReadOnlyRunnerCommand,
  isRunnerReadinessProbeCommand,
} from './runner-command-traits.ts';
import {
  buildDetachedRunnerLease,
  buildRunnerLease,
  prepareRunnerLeaseForStartup,
  RUNNER_OWNER_TOKEN,
  withRunnerLeaseLock,
  writeRunnerLease,
} from './runner-lease.ts';
import { isIosRunnerDetachEnabled, tryAdoptRunnerSessionFromLease } from './runner-adoption.ts';
import {
  abortRunnerSessionsAndPrepProcesses,
  cleanupOwnedIosRunnerLease,
  disposeRunnerSession,
  isRunnerProcessAlive,
  runnerLeaseCleanupAdapter,
  RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
  stopRunnerPrepProcesses,
} from './runner-disposal.ts';
import { enrichRunnerFailureFromLog } from './runner-failure-diagnostics.ts';
import {
  buildRunnerSessionId,
  normalizeRunnerStartupTimeoutMs,
  type RunnerSession,
} from './runner-session-types.ts';

export type { RunnerSession } from './runner-session-types.ts';

export type RunnerSessionOptions = AppleRunnerLifecycleOptions;

const runnerSessions = new Map<string, RunnerSession>();
const runnerSessionLocks = new Map<string, Promise<unknown>>();
const runnerIdleStopTimers = new Map<string, NodeJS.Timeout>();
const RUNNER_RETAINED_IDLE_STOP_DEFAULT_MS = 5 * 60_000;
const RUNNER_READY_PREFLIGHT_TIMEOUT_MS = 1_000;
const RUNNER_STALE_BUNDLE_UNINSTALL_TIMEOUT_MS = 10_000;
const RUNNER_PREFLIGHT_SKIP_FRESHNESS_MS = 5_000;

type RunnerReadinessPreflightDecision =
  | {
      action: 'run';
      reason:
        | 'startup'
        | 'conservative_command'
        | 'no_recent_healthy_mutation'
        | 'app_activation_uncertain'
        | 'healthy_mutation_stale';
      lastHealthyMutationAgeMs?: number;
    }
  | {
      action: 'skip';
      reason: 'read_only_startup_command' | 'readiness_probe_command';
    }
  | {
      action: 'skip';
      reason: 'recent_healthy_mutation';
      lastHealthyMutationAgeMs: number;
    };

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
  return await withRunnerSessionLock(device.id, async () => {
    const existing = runnerSessions.get(device.id);
    if (existing) {
      const reusable = await resolveReusableRunnerSession(device, existing);
      if (reusable) return reusable;
    }

    return await withRunnerLeaseLock(
      device.id,
      async () => await startRunnerSessionWithLease(device, options),
    );
  });
}

async function startRunnerSessionWithLease(
  device: DeviceInfo,
  options: RunnerSessionOptions,
): Promise<RunnerSession> {
  const startupTimings: Record<string, number> = {};
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
        startupTimeoutMs: options.startupTimeoutMs,
      }),
  );
  if (adopted) {
    adopted.startupTimings = startupTimings;
    adopted.logicalLeaseContext = logicalLeaseContext;
    runnerSessions.set(device.id, adopted);
    return adopted;
  }
  await measureRunnerStartupStep(startupTimings, 'cleanup_stale_xcodebuild', async () => {
    await prepareRunnerLeaseForStartup(device.id, runnerLeaseCleanupAdapter, logicalLeaseContext);
  });
  await measureRunnerStartupStep(startupTimings, 'ensure_booted', async () => {
    await ensureBootedIfNeeded(device);
  });
  await measureRunnerStartupStep(startupTimings, 'verify_developer_mode', async () => {
    await verifyDeveloperModeForIosRunner(device);
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
  const xctestrunArtifact = await measureRunnerStartupStep(
    startupTimings,
    'ensure_xctestrun',
    async () => await ensureXctestrunArtifact(device, options),
  );
  startupTimings.build_xctestrun = xctestrunArtifact.buildMs;
  const port = await measureRunnerStartupStep(
    startupTimings,
    'allocate_port',
    async () => await getFreePort(),
  );
  const { xctestrunPath, jsonPath } = await measureRunnerStartupStep(
    startupTimings,
    'prepare_xctestrun_env',
    async () =>
      await prepareXctestrunWithEnv(
        xctestrunArtifact.xctestrunPath,
        { AGENT_DEVICE_RUNNER_PORT: String(port) },
        `session-${device.id}-${RUNNER_OWNER_TOKEN}-${port}`,
        { iosXctestEnvDir: options.iosXctestEnvDir },
      ),
  );
  const simulatorSetRedirect = await measureRunnerStartupStep(
    startupTimings,
    'simulator_set_redirect',
    async () => await acquireXcodebuildSimulatorSetRedirect(device),
  );
  let child: ExecBackgroundResult['child'] | undefined;
  let testPromise: Promise<ExecResult>;
  const xcodebuildArgs = [
    'test-without-building',
    '-only-testing',
    'AgentDeviceRunnerUITests/RunnerTests/testCommand',
    '-parallel-testing-enabled',
    'NO',
    '-test-timeouts-enabled',
    'NO',
    '-collect-test-diagnostics',
    'never',
    resolveRunnerMaxConcurrentDestinationsFlag(device),
    '1',
    '-destination-timeout',
    String(RUNNER_DESTINATION_TIMEOUT_SECONDS),
    '-xctestrun',
    xctestrunPath,
    '-derivedDataPath',
    xctestrunArtifact.derived,
    '-destination',
    resolveRunnerDestination(device),
  ];
  try {
    if (xctestrunArtifact.buildMs > 0) {
      emitRequestProgress({
        type: 'command',
        status: 'progress',
        message: 'Starting XCTest runner...',
      });
    }
    ({ child, wait: testPromise } = await measureRunnerStartupStep(
      startupTimings,
      'launch_xcodebuild',
      () =>
        runCmdBackground('xcodebuild', xcodebuildArgs, {
          allowFailure: true,
          env: { ...process.env, AGENT_DEVICE_RUNNER_PORT: String(port) },
          detached: true,
        }),
    ));
  } catch (error) {
    await simulatorSetRedirect?.release();
    throw error;
  }
  child.stdout?.on('data', (chunk: string) => {
    logChunk(chunk, options.logPath, options.traceLogPath, options.verbose);
  });
  child.stderr?.on('data', (chunk: string) => {
    logChunk(chunk, options.logPath, options.traceLogPath, options.verbose);
  });

  const sessionId = buildRunnerSessionId(device.id, port);
  const lease = buildRunnerLease({
    deviceId: device.id,
    sessionId,
    runnerPid: child.pid,
    port,
    xctestrunPath,
    jsonPath,
  });
  const session: RunnerSession = {
    sessionId,
    device,
    deviceId: device.id,
    port,
    xctestrunPath,
    xctestrunArtifact,
    jsonPath,
    testPromise,
    child,
    ready: false,
    startupTimeoutMs: normalizeRunnerStartupTimeoutMs(options.startupTimeoutMs),
    startupTimings,
    logicalLeaseContext,
    simulatorSetRedirect: simulatorSetRedirect ?? undefined,
    lease,
  };
  try {
    writeRunnerLease(lease);
  } catch (error) {
    await stopRunnerSessionInternal(device.id, session, {
      graceful: false,
      waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
    });
    throw error;
  }
  runnerSessions.set(device.id, session);
  return session;
}

async function resolveReusableRunnerSession(
  device: DeviceInfo,
  existing: RunnerSession,
): Promise<RunnerSession | null> {
  if (!isRunnerProcessAlive(existing.child.pid)) {
    await measureRunnerStartupStep({}, 'stop_stale_session', async () => {
      await stopRunnerSessionInternal(device.id, existing, {
        graceful: false,
        waitTimeoutMs: RUNNER_INVALIDATE_WAIT_TIMEOUT_MS,
      });
    });
    return null;
  }

  const existingArtifact = existing.xctestrunArtifact;
  if (existingArtifact?.cache === 'external') {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_session_reuse',
      data: {
        deviceId: device.id,
        sessionId: existing.sessionId,
        ready: existing.ready,
        cache: existingArtifact.cache,
        logicalLeaseContext: existing.logicalLeaseContext,
      },
    });
    return existing;
  }

  const expectedDerived = resolveRunnerDerivedPath(
    device,
    resolveExpectedRunnerCacheMetadata(device),
  );
  if (existingArtifact?.derived !== expectedDerived) {
    emitDiagnostic({
      level: 'debug',
      phase: 'ios_runner_session_artifact_stale',
      data: {
        deviceId: device.id,
        sessionId: existing.sessionId,
        currentDerived: existingArtifact?.derived,
        expectedDerived,
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
      ready: existing.ready,
      logicalLeaseContext: existing.logicalLeaseContext,
    },
  });
  return existing;
}

async function cleanupStaleSimulatorRunnerBundles(device: DeviceInfo): Promise<void> {
  if (device.kind !== 'simulator') {
    return;
  }

  for (const bundleId of IOS_RUNNER_CONTAINER_BUNDLE_IDS) {
    const result = await uninstallStaleSimulatorRunnerBundle(device, bundleId);
    if (!result || isBenignSimulatorRunnerUninstallResult(result)) {
      continue;
    }
    // Best-effort cleanup only; xcodebuild may still be able to install.
  }
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

export function getRunnerSessionSnapshot(
  deviceId: string,
): { sessionId: string; alive: boolean } | null {
  const session = runnerSessions.get(deviceId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    alive: isRunnerProcessAlive(session.child.pid),
  };
}

export async function invalidateRunnerSession(
  session: RunnerSession,
  reason: string,
): Promise<void> {
  await withRunnerSessionLock(session.deviceId, async () => {
    if (runnerSessions.get(session.deviceId) !== session) return;
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
  options: { graceful?: boolean; waitTimeoutMs?: number } = {},
): Promise<void> {
  const session = sessionOverride ?? runnerSessions.get(deviceId);
  if (!session) return;
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

export async function stopIosRunnerSession(deviceId: string): Promise<void> {
  cancelIosRunnerIdleStop(deviceId);
  await withRunnerSessionLock(deviceId, async () => {
    await withRunnerLeaseLock(deviceId, async () => {
      await stopRunnerSessionInternal(deviceId);
      await cleanupOwnedIosRunnerLease(deviceId);
    });
  });
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

// Graceful daemon shutdown hands healthy simulator runners off to the next
// daemon instead of paying the ~5s xcodebuild ramp again: the lease token is
// rewritten to a detached form (so this daemon's own teardown paths no longer
// classify it as owned) and the session simply leaves the in-memory map. Once
// this process exits the lease is stale and the adoption path picks it up.
// Explicit cleanup still works: clean:daemon kills by the lease's runnerPid,
// and the runner's XCTWaiter self-expires after 24h.
export async function detachIosSimulatorRunnerSessionsForShutdown(): Promise<number> {
  if (!isIosRunnerDetachEnabled()) return 0;
  let detached = 0;
  for (const [deviceId, session] of runnerSessions) {
    if (session.device.kind !== 'simulator') continue;
    // CONSERVATIVE: Scoped simulator sets depend on the global XCTestDevices symlink for their
    // whole runner lifetime; handoff could restore the symlink under a live runner or leak the
    // redirect lock. Revisit only if simulator-set redirects become runner-owned instead of
    // daemon-session-owned.
    if (session.simulatorSetRedirect) continue;
    if (!session.lease || !isRunnerProcessAlive(session.child.pid)) continue;
    try {
      writeRunnerLease(buildDetachedRunnerLease(session.lease));
    } catch {
      continue; // Could not mark the handoff; leave it for the kill path.
    }
    runnerSessions.delete(deviceId);
    cancelIosRunnerIdleStop(deviceId);
    detached += 1;
    emitDiagnostic({
      level: 'info',
      phase: 'ios_runner_session_detached',
      data: {
        deviceId,
        sessionId: session.sessionId,
        runnerPid: session.child.pid,
        port: session.port,
      },
    });
  }
  return detached;
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

async function verifyDeveloperModeForIosRunner(device: DeviceInfo): Promise<void> {
  if (!isIosFamily(device) || device.kind !== 'device') return;
  const result = await runAppleToolCommand('DevToolsSecurity', ['-status'], {
    allowFailure: true,
    timeoutMs: 2_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (!/developer mode is currently disabled/i.test(output)) return;
  throw new AppError('COMMAND_FAILED', 'Developer mode is disabled for Apple development tools', {
    hint: 'Run `sudo DevToolsSecurity -enable`, then retry the iOS runner. UI test runners start suspended until Xcode/testmanagerd can attach.',
    devToolsSecurityStatus: output.trim(),
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

export async function executeRunnerCommandWithSession(
  device: DeviceInfo,
  session: RunnerSession,
  command: RunnerCommand,
  logPath: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  emitRunnerStartupTimings(session, command.command);
  const runnerCommand = withRunnerCommandId(command);
  const readOnlyCommand = isReadOnlyRunnerCommand(runnerCommand.command);
  const deadline = Deadline.fromTimeoutMs(timeoutMs);
  const preflightDecision = resolveRunnerReadinessPreflightDecision(session, runnerCommand);
  if (preflightDecision.action === 'run') {
    await runRunnerReadinessPreflight({
      device,
      session,
      runnerCommand,
      logPath,
      deadline,
      signal,
      decision: preflightDecision,
    });
  } else {
    emitRunnerReadinessPreflightSkipped(runnerCommand, session, preflightDecision);
  }

  let response: Response;
  try {
    response = await sendRunnerCommandAfterPreflight({
      device,
      session,
      runnerCommand,
      logPath,
      deadline,
      timeoutMs,
      signal,
      readOnlyCommand,
    });
  } catch (error) {
    // A transport failure right after a skipped preflight means the recency
    // bet was wrong; clear it so a flaky transport cannot loop on stale skips,
    // and mark the error with the skip context for status recovery. The marker
    // key is disjoint from runnerReadinessPreflightFailed, so this never routes
    // into the restart-and-replay path.
    throw markSkippedPreflightTransportError(error, session, preflightDecision);
  }
  try {
    const data = await parseRunnerResponse(response, session, logPath);
    const runnerFatalReason = resolveRunnerFatalReason(data);
    if (runnerFatalReason) {
      session.lastHealthyMutation = undefined;
      await invalidateRunnerSession(session, runnerFatalReason);
    } else if (canSkipRunnerReadinessPreflightAfterHealthyMutation(runnerCommand.command)) {
      session.lastHealthyMutation = {
        atMs: Date.now(),
        appBundleId: runnerCommand.appBundleId,
      };
    }
    return data;
  } catch (error) {
    const runnerFatalReason = resolveRunnerFatalErrorReason(error);
    if (runnerFatalReason) {
      session.lastHealthyMutation = undefined;
      await invalidateRunnerSession(session, runnerFatalReason);
      throw error;
    }
    // A body-read or malformed-payload failure is transport-shaped too (the
    // runner died mid-response); structured runner failures carry a `runner`
    // detail and keep their recency — the runner proved it is alive by
    // answering at all.
    if (isStructuredRunnerFailure(error)) throw error;
    throw markSkippedPreflightTransportError(error, session, preflightDecision);
  }
}

function isStructuredRunnerFailure(error: unknown): boolean {
  return error instanceof AppError && error.details?.runner !== undefined;
}

function markSkippedPreflightTransportError(
  error: unknown,
  session: RunnerSession,
  preflightDecision: RunnerReadinessPreflightDecision,
): unknown {
  if (
    preflightDecision.action !== 'skip' ||
    preflightDecision.reason !== 'recent_healthy_mutation'
  ) {
    return error;
  }
  session.lastHealthyMutation = undefined;
  return markRunnerPreflightError(error, {
    runnerReadinessPreflightSkipped: true,
    runnerReadinessPreflightSkipReason: preflightDecision.reason,
    runnerReadinessPreflightSkippedAgeMs: preflightDecision.lastHealthyMutationAgeMs,
  });
}

async function sendRunnerCommandAfterPreflight(params: {
  device: DeviceInfo;
  session: RunnerSession;
  runnerCommand: RunnerCommand;
  logPath: string | undefined;
  deadline: Deadline;
  timeoutMs: number;
  signal: AbortSignal | undefined;
  readOnlyCommand: boolean;
}): Promise<Response> {
  const { device, session, runnerCommand, logPath, deadline, timeoutMs, signal, readOnlyCommand } =
    params;
  const remainingMs = deadline.remainingMs();
  if (remainingMs <= 0) {
    throw new AppError('COMMAND_FAILED', 'Runner command deadline exceeded', { timeoutMs });
  }
  const diagnosticData = readOnlyCommand
    ? {
        command: runnerCommand.command,
        commandId: runnerCommand.commandId,
        readOnly: true,
        sessionReady: session.ready,
        timeoutMs: remainingMs,
      }
    : { command: runnerCommand.command, commandId: runnerCommand.commandId };

  return await withDiagnosticTimer(
    'ios_runner_command_send',
    async () => {
      if (readOnlyCommand) {
        return await waitForRunner(
          device,
          session.port,
          runnerCommand,
          logPath,
          remainingMs,
          session,
          signal,
        );
      }
      return await sendRunnerCommandOnce(device, session.port, runnerCommand, remainingMs, signal);
    },
    diagnosticData,
  );
}

async function runRunnerReadinessPreflight(params: {
  device: DeviceInfo;
  session: RunnerSession;
  runnerCommand: RunnerCommand;
  logPath: string | undefined;
  deadline: Deadline;
  signal: AbortSignal | undefined;
  decision: Extract<RunnerReadinessPreflightDecision, { action: 'run' }>;
}): Promise<void> {
  const { device, session, runnerCommand, logPath, deadline, signal, decision } = params;
  const readinessTimeoutMs = session.ready
    ? Math.min(RUNNER_READY_PREFLIGHT_TIMEOUT_MS, deadline.remainingMs())
    : Math.min(readRunnerStartupTimeoutMs(session), deadline.remainingMs());
  try {
    const readinessResponse = await withDiagnosticTimer(
      'ios_runner_readiness_preflight',
      async () =>
        await waitForRunner(
          device,
          session.port,
          withRunnerCommandId({ command: 'uptime' }),
          logPath,
          readinessTimeoutMs,
          session,
          signal,
        ),
      {
        command: runnerCommand.command,
        commandId: runnerCommand.commandId,
        reason: decision.reason,
        lastHealthyMutationAgeMs: decision.lastHealthyMutationAgeMs,
        sessionReady: session.ready,
        timeoutMs: readinessTimeoutMs,
      },
    );
    await parseRunnerResponse(readinessResponse, session, logPath);
  } catch (error) {
    throw markRunnerReadinessPreflightError(error);
  }
}

function emitRunnerReadinessPreflightSkipped(
  runnerCommand: RunnerCommand,
  session: RunnerSession,
  decision: Extract<RunnerReadinessPreflightDecision, { action: 'skip' }>,
): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_readiness_preflight_skipped',
    data: {
      command: runnerCommand.command,
      commandId: runnerCommand.commandId,
      reason: decision.reason,
      lastHealthyMutationAgeMs:
        decision.reason === 'recent_healthy_mutation'
          ? decision.lastHealthyMutationAgeMs
          : undefined,
      sessionReady: session.ready,
    },
  });
}

type RunnerResponsePayload = {
  ok?: unknown;
  error?: { code?: unknown; message?: unknown; hint?: unknown };
  data?: unknown;
};

export async function parseRunnerResponse(
  response: Response,
  session: Pick<RunnerSession, 'ready'>,
  logPath?: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  let json: RunnerResponsePayload;
  try {
    const parsed: unknown = JSON.parse(text);
    json = parsed && typeof parsed === 'object' ? (parsed as RunnerResponsePayload) : {};
  } catch {
    throw new AppError('COMMAND_FAILED', 'Invalid runner response', { text });
  }
  if (!json.ok) {
    const rawCode = json.error?.code;
    const errorCode =
      typeof rawCode === 'string' && rawCode.trim().length > 0
        ? toAppErrorCode(rawCode)
        : 'COMMAND_FAILED';
    const errorMessage = typeof json.error?.message === 'string' ? json.error.message : undefined;
    const hint = typeof json.error?.hint === 'string' ? json.error.hint : undefined;
    throw await enrichRunnerFailureFromLog({
      error: new AppError(errorCode, errorMessage ?? 'Runner error', {
        runner: json,
        xcodebuild: {
          exitCode: 1,
          stdout: '',
          stderr: '',
        },
        hint,
        logPath,
      }),
      logPath,
    });
  }
  session.ready = true;
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data)) {
    const data = json.data as Record<string, unknown>;
    emitRunnerResponseDiagnostics(data);
    return data;
  }
  return {};
}

function emitRunnerResponseDiagnostics(data: Record<string, unknown>): void {
  const fallback = data.gestureFallback;
  if (typeof fallback !== 'string' || fallback.length === 0) return;
  emitDiagnostic({
    level: 'debug',
    phase: 'ios_runner_gesture_fallback',
    data: {
      fallback,
      message:
        typeof data.gestureFallbackMessage === 'string' ? data.gestureFallbackMessage : undefined,
      hint: typeof data.gestureFallbackHint === 'string' ? data.gestureFallbackHint : undefined,
    },
  });
}

function resolveRunnerFatalReason(data: Record<string, unknown>): string | undefined {
  if (data.runnerFatal !== true) return undefined;
  return typeof data.runnerFatalReason === 'string' && data.runnerFatalReason.trim().length > 0
    ? data.runnerFatalReason
    : 'runner_reported_fatal_response';
}

function resolveRunnerFatalErrorReason(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  if (error.code === 'IOS_AX_SNAPSHOT_FAILED') return 'ax_snapshot_failure';
  if (error.code === 'XCTEST_RECORDED_FAILURE') return 'xctest_recorded_failure';
  // The runner reported its main thread stuck in abandoned work past the wedge threshold
  // (#1105): only a restart cures it. The per-request recycle budget still bounds how many
  // boots one request pays for.
  if (error.code === 'RUNNER_WEDGED') return 'runner_main_thread_wedged';
  return undefined;
}

function resolveRunnerReadinessPreflightDecision(
  session: RunnerSession,
  command: RunnerCommand,
): RunnerReadinessPreflightDecision {
  const readOnlyCommand = isReadOnlyRunnerCommand(command.command);
  if (!session.ready) {
    if (readOnlyCommand) {
      return {
        action: 'skip',
        reason: 'read_only_startup_command',
      };
    }
    return {
      action: 'run',
      reason: 'startup',
    };
  }
  if (isRunnerReadinessProbeCommand(command.command)) {
    return {
      action: 'skip',
      reason: 'readiness_probe_command',
    };
  }
  if (!canSkipRunnerReadinessPreflightAfterHealthyMutation(command.command)) {
    // CONSERVATIVE: Commands outside the healthy-mutation allowlist still preflight because their
    // terminal runner state is not proven by recency. Revisit when lifecycle status coverage can
    // distinguish every mutating command's safe terminal state.
    return {
      action: 'run',
      reason: 'conservative_command',
    };
  }
  const record = session.lastHealthyMutation;
  if (!record) {
    return {
      action: 'run',
      reason: 'no_recent_healthy_mutation',
    };
  }
  if (command.appBundleId !== record.appBundleId) {
    return {
      action: 'run',
      reason: 'app_activation_uncertain',
    };
  }
  const lastHealthyMutationAgeMs = Date.now() - record.atMs;
  if (lastHealthyMutationAgeMs > RUNNER_PREFLIGHT_SKIP_FRESHNESS_MS) {
    return {
      action: 'run',
      reason: 'healthy_mutation_stale',
      lastHealthyMutationAgeMs,
    };
  }
  return {
    action: 'skip',
    reason: 'recent_healthy_mutation',
    lastHealthyMutationAgeMs,
  };
}

function markRunnerReadinessPreflightError(error: unknown): AppError {
  return markRunnerPreflightError(error, {
    runnerReadinessPreflightFailed: true,
  });
}

function markRunnerPreflightError(error: unknown, details: Record<string, unknown>): AppError {
  const appErr =
    error instanceof AppError
      ? error
      : new AppError(
          'COMMAND_FAILED',
          error instanceof Error ? error.message : String(error),
          undefined,
          error,
        );
  return new AppError(
    appErr.code,
    appErr.message,
    {
      ...(appErr.details ?? {}),
      ...details,
    },
    appErr.cause ?? error,
  );
}

export function readRunnerStartupTimeoutMs(
  session: Pick<RunnerSession, 'startupTimeoutMs'>,
): number {
  return session.startupTimeoutMs ?? RUNNER_STARTUP_TIMEOUT_MS;
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
      ready: session.ready,
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
