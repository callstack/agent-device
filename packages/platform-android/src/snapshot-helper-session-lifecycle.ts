/**
 * Who owns the device's UiAutomation right now, and how that ownership starts and ends.
 *
 * `am instrument` force-stops whatever is already instrumenting the helper package, so a live helper
 * session is device-exclusive state: this module is the only place that starts one, hands it out, and
 * retires it. Commands run OVER a session (snapshot capture, gestures) live in
 * `snapshot-helper-session.ts`; they acquire through here and never reach the registry themselves.
 */
import type { AndroidAdbProcess } from './adb-executor.ts';
import { requireAndroidAdbHost } from './adb-host.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  androidAdbForwardsDeviceExitStatus,
  resetAndroidAdbShellProtocolProbes,
} from './adb-shell-protocol.ts';
import type {
  AndroidAdbExecutor,
  AndroidSnapshotHelperCaptureOptions,
} from './snapshot-helper-types.ts';
import {
  buildAndroidSnapshotHelperArgs,
  resolveAndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperResolvedCaptureOptions,
} from './snapshot-helper-capture.ts';
import {
  allocateAndroidSnapshotHelperSessionPort,
  isAndroidSnapshotHelperSessionCommandAcknowledged,
  sendAndroidSnapshotHelperSessionCommand,
  waitForAndroidSnapshotHelperSessionReady,
} from './snapshot-helper-session-protocol.ts';
import {
  type AndroidSnapshotHelperProcessExit,
  ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS,
  ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS,
  getAndroidSnapshotHelperSessionDeviceKey,
  hasAndroidSnapshotHelperProcessEnded,
  observeAndroidSnapshotHelperProcessExit,
  recoverAndroidSnapshotHelperRetirement,
  recordAndroidSnapshotHelperRelease,
  resetAndroidSnapshotHelperRetirements,
  settleAndroidSnapshotHelperRetirement,
  settleAndroidSnapshotHelperSessionCleanup,
  stopAndroidSnapshotHelperHostProcess,
  waitForAndroidSnapshotHelperProcessExit,
} from './snapshot-helper-retirement.ts';

const SESSION_STOP_TIMEOUT_MS = 1_000;
// SnapshotInstrumentation.finishSafely can spend up to 10 seconds waiting for Android to finish
// connecting UiAutomation. Let an acknowledged quit complete that release before force-killing adb.
const SESSION_GRACEFUL_EXIT_TIMEOUT_MS = 11_000;
const SESSION_PROCESS_EXIT_TIMEOUT_MS = 2_000;
// Persistent capture is an optimization before the required one-shot path. Keep its native and
// transport budgets shorter so a wedged UiAutomation connection leaves time for a clean fallback.
const SESSION_CAPTURE_TIMEOUT_MS = 2_000;
const SESSION_REQUEST_OVERHEAD_MS = 3_000;
const FORWARD_TIMEOUT_MS = 5_000;
// A helper that cannot start spends its whole start budget failing, and the one-shot transport that
// answers afterwards still has to run. Retrying that on the very next command is what made commands
// on the slow hosts of #2553 take roughly twice as long, so a failed start keeps the persistent path
// away for at least this long.
const SESSION_START_RETRY_FLOOR_MS = 10_000;
// …and for no longer than this, however long the start took. The floor keeps a burst of commands
// from re-paying an instant failure; the ceiling keeps a host whose helper is simply broken from
// being written off for longer than a working session would have lasted.
const SESSION_START_RETRY_CEILING_MS = 60_000;

export type AndroidSnapshotHelperSessionHelperIdentity = {
  packageName: string;
  runner: string;
  helperVersion?: string;
  helperVersionCode?: number;
  sha256?: string;
};

export type AndroidSnapshotHelperSession = {
  identity: string;
  deviceKey: string;
  helper: AndroidSnapshotHelperSessionHelperIdentity;
  port: number;
  adb: AndroidAdbExecutor;
  process: AndroidAdbProcess;
  startedAtMs: number;
  capturedCount: number;
};

/** A session this caller may run commands on, with the budgets it was started under. */
export type AndroidSnapshotHelperSessionAcquisition = {
  session: AndroidSnapshotHelperSession;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
  deviceKey: string;
};

const sessions = new Map<string, AndroidSnapshotHelperSession>();
/** Capture identity → when this process may spawn that helper build again after a failed start. */
const failedStarts = new Map<string, number>();

/**
 * Starts (or reuses) the session without capturing, so a helper-backed read that is not a snapshot
 * — the gesture viewport — can leave a warm session behind for the gesture that follows instead of
 * paying its own one-shot instrumentation. Answers whether a session is live; `false` means the
 * caller must use the one-shot transport, exactly as when a capture cannot use the session.
 */
export async function ensureAndroidSnapshotHelperSession(
  options: AndroidSnapshotHelperCaptureOptions,
): Promise<boolean> {
  return (await acquireAndroidSnapshotHelperSession(options)) !== undefined;
}

export async function acquireAndroidSnapshotHelperSession(
  options: AndroidSnapshotHelperCaptureOptions,
): Promise<AndroidSnapshotHelperSessionAcquisition | undefined> {
  const deviceKey = options.deviceKey ?? 'android:default';
  await recoverAndroidSnapshotHelperRetirement({
    deviceKey,
    adb: options.adb,
    signal: options.signal,
  });
  if (!isAndroidSnapshotHelperSessionEnabled() || !options.adbProvider?.spawn) {
    return undefined;
  }
  const callerResolved = resolveAndroidSnapshotHelperCaptureOptions(options);
  const resolved = resolvePersistentSessionCaptureOptions(callerResolved);
  const identity = createSessionIdentity(deviceKey, resolved, options);
  const session = await resolveAndroidSnapshotHelperSession({
    deviceKey,
    identity,
    options,
    resolved,
    startBudgetMs: resolveAndroidSnapshotHelperStartBudgetMs(callerResolved.commandTimeoutMs),
  });
  return session ? { session, resolved, deviceKey } : undefined;
}

/**
 * The live session for a device, or `undefined` when none is running. Commands that may only
 * piggyback on an existing session — never start one — read ownership through this.
 */
export function getLiveAndroidSnapshotHelperSession(
  deviceKey: string,
): AndroidSnapshotHelperSession | undefined {
  return sessions.get(deviceKey);
}

async function resolveAndroidSnapshotHelperSession(params: {
  deviceKey: string;
  identity: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
  startBudgetMs: number;
}): Promise<AndroidSnapshotHelperSession | undefined> {
  if (isAndroidSnapshotHelperStartBackedOff(params.identity)) return undefined;
  await retireUnusableAndroidSnapshotHelperSession(params.deviceKey, params.identity);
  return sessions.get(params.deviceKey) ?? (await tryStartAndroidSnapshotHelperSession(params));
}

/** Drops a cached session this command cannot write to, so only its forward is left behind. */
async function retireUnusableAndroidSnapshotHelperSession(
  deviceKey: string,
  identity: string,
): Promise<void> {
  const cached = sessions.get(deviceKey);
  if (!cached || isReusableAndroidSnapshotHelperSession(cached, identity)) return;
  // A process that already exited cannot answer the forwarded port, so there is nothing left to ask
  // it to quit gracefully.
  await stopAndroidSnapshotHelperSession(deviceKey, {
    force: hasAndroidSnapshotHelperProcessEnded(cached.process),
  });
}

/**
 * Starts the helper, or answers `undefined` for a start that failed. A start that failed is not a
 * command that failed — the caller answers with the one-shot transport — and this helper build is
 * not spawned again until the backoff it just earned is over.
 */
async function tryStartAndroidSnapshotHelperSession(params: {
  deviceKey: string;
  identity: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
  startBudgetMs: number;
}): Promise<AndroidSnapshotHelperSession | undefined> {
  const startedAtMs = Date.now();
  try {
    return await startAndroidSnapshotHelperSession(params);
  } catch (error) {
    params.options.signal?.throwIfAborted();
    failedStarts.set(
      params.identity,
      Date.now() + androidSnapshotHelperStartRetryAfterMs(Date.now() - startedAtMs),
    );
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_start_failed',
      data: {
        deviceKey: params.deviceKey,
        reason: error instanceof AppError ? error.details?.reason : undefined,
        detail: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

/** A helper build whose last start failed is left alone until that start's backoff has run out. */
function isAndroidSnapshotHelperStartBackedOff(identity: string): boolean {
  const retryAtMs = failedStarts.get(identity);
  if (retryAtMs === undefined) return false;
  if (retryAtMs > Date.now()) return true;
  failedStarts.delete(identity);
  return false;
}

/**
 * How long a failed start earns: as long as it spent failing, because a start that burned half a
 * minute on a wedged device would burn another half minute on the next command, bounded so a burst
 * of commands neither re-pays an instant failure nor writes a device off for the rest of the run.
 */
function androidSnapshotHelperStartRetryAfterMs(startDurationMs: number): number {
  return Math.min(
    Math.max(startDurationMs, SESSION_START_RETRY_FLOOR_MS),
    SESSION_START_RETRY_CEILING_MS,
  );
}

/**
 * A cached session is worth writing to only while it belongs to this helper build and its
 * instrumentation process is still running. The helper binds its session socket inside that
 * process, so a process that has exited has nobody left to accept on the forwarded port: the
 * command would die on a dead socket and fall back, instead of starting a helper that can answer.
 */
function isReusableAndroidSnapshotHelperSession(
  session: AndroidSnapshotHelperSession,
  identity: string,
): boolean {
  return session.identity === identity && !hasAndroidSnapshotHelperProcessEnded(session.process);
}

async function startAndroidSnapshotHelperSession(params: {
  deviceKey: string;
  identity: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
  startBudgetMs: number;
}): Promise<AndroidSnapshotHelperSession> {
  const port = await allocateAndroidSnapshotHelperSessionPort();
  await params.options.adb(['forward', `tcp:${port}`, `tcp:${port}`], {
    allowFailure: false,
    timeoutMs: FORWARD_TIMEOUT_MS,
    signal: params.options.signal,
  });
  const args = buildAndroidSnapshotHelperArgs({
    ...params.resolved,
    outputPath: undefined,
    emitChunks: false,
  });
  const runner = args.at(-1);
  if (!runner) {
    throw new AppError('INVALID_ARGS', 'Android snapshot helper runner was not resolved');
  }
  const sessionArgs = [...args.slice(0, -1), '-e', 'sessionPort', String(port), runner];
  const childProcess = params.options.adbProvider!.spawn!(sessionArgs, {
    allowFailure: true,
    captureOutput: false,
  });
  const session: AndroidSnapshotHelperSession = {
    identity: params.identity,
    deviceKey: params.deviceKey,
    helper: {
      packageName: params.resolved.packageName,
      runner: params.resolved.runner,
      helperVersion: params.options.helperVersion,
      helperVersionCode: params.options.helperVersionCode,
      sha256: params.options.helperSha256,
    },
    port,
    adb: params.options.adb,
    process: childProcess,
    startedAtMs: Date.now(),
    capturedCount: 0,
  };
  try {
    // A helper that announces itself late is a slow `am instrument`, which the one-shot transport it
    // falls back to pays too, so the wait gets a share of the helper-command budget rather than a
    // smaller guess. The caller's own deadline reaches it as an abort on `options.signal`, which is
    // what bounds this below the budget when the command itself is short.
    await waitForAndroidSnapshotHelperSessionReady(
      childProcess,
      params.startBudgetMs,
      params.options.signal,
    );
    sessions.set(params.deviceKey, session);
    failedStarts.delete(params.identity);
    // `am instrument` force-stops whatever is already instrumenting this package, so a helper that
    // reported itself ready is the only helper process the device has left, and the release the
    // previous teardown could not prove went away with the process that owed it. Leaving the entry
    // pending would have the next acquire force-stop the session that just started.
    settleAndroidSnapshotHelperRetirement(params.deviceKey);
    emitDiagnostic({
      phase: 'android_snapshot_helper_session_ready',
      data: {
        deviceKey: params.deviceKey,
        port,
        packageName: params.resolved.packageName,
        runner: params.resolved.runner,
      },
    });
    return session;
  } catch (error) {
    const processExit = observeAndroidSnapshotHelperProcessExit(childProcess);
    try {
      childProcess.kill('SIGTERM');
    } catch {
      // Best effort after startup failure.
    }
    await Promise.all([
      waitForAndroidSnapshotHelperProcessExit(
        processExit.ended,
        ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS,
      ),
      settleAndroidSnapshotHelperSessionCleanup({
        adb: session.adb,
        process: session.process,
        port: session.port,
        packageName: session.helper.packageName,
        timeoutMs: ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS,
        // Startup failed before the helper could acknowledge anything, so nothing proves it
        // released UiAutomation.
        forceStopRuntime: true,
      }),
    ]);
    // What this command reports is the failed start, which the caller answers with the one-shot
    // transport. Whether the device is still owned is a fact the next acquire reads.
    await recordAndroidSnapshotHelperRelease({
      deviceKey: params.deviceKey,
      packageName: session.helper.packageName,
      adb: session.adb,
      cause: error,
    });
    throw error;
  }
}

function createSessionIdentity(
  deviceKey: string,
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
  options: AndroidSnapshotHelperCaptureOptions,
): string {
  const identity = JSON.stringify({
    deviceKey,
    packageName: resolved.packageName,
    runner: resolved.runner,
    helperVersion: options.helperVersion,
    helperVersionCode: options.helperVersionCode,
    helperSha256: options.helperSha256,
    waitForIdleTimeoutMs: resolved.waitForIdleTimeoutMs,
    waitForIdleQuietMs: resolved.waitForIdleQuietMs,
    timeoutMs: resolved.timeoutMs,
    maxDepth: resolved.maxDepth,
    maxNodes: resolved.maxNodes,
  });
  return identity;
}

function resolvePersistentSessionCaptureOptions(
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
): AndroidSnapshotHelperResolvedCaptureOptions {
  const timeoutMs = Math.min(resolved.timeoutMs, SESSION_CAPTURE_TIMEOUT_MS);
  return {
    ...resolved,
    timeoutMs,
    commandTimeoutMs: Math.min(resolved.commandTimeoutMs, timeoutMs + SESSION_REQUEST_OVERHEAD_MS),
  };
}

/**
 * What a start gets out of the helper-command budget it was built with: half of it, so a helper that
 * announces itself later than a session capture takes is not pushed off the persistent path by a
 * capture-sized guess, while the one-shot transport that answers a failed start keeps the other half.
 * Never less than one session command is worth, never more than the budget. Production builds that
 * budget from `ANDROID_SNAPSHOT_HELPER_COMMAND_TIMEOUT_MS` (30 s today, so 15 s here) rather than
 * from the CLI's `--timeout`, whose deadline reaches this wait as an abort instead.
 */
export function resolveAndroidSnapshotHelperStartBudgetMs(commandTimeoutMs: number): number {
  return Math.min(
    commandTimeoutMs,
    Math.max(
      Math.floor(commandTimeoutMs / 2),
      SESSION_CAPTURE_TIMEOUT_MS + SESSION_REQUEST_OVERHEAD_MS,
    ),
  );
}

function isAndroidSnapshotHelperSessionEnabled(): boolean {
  const value = requireAndroidAdbHost().environment.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  return value === undefined || !/^(0|false|no|off)$/i.test(value);
}

export async function stopAndroidSnapshotHelperSession(
  deviceKey: string,
  options: {
    /** Skip the graceful quit entirely: kill the host process and stop the device runtime. */
    force?: boolean;
    /**
     * Stop the device runtime even when the quit proved release. Recovery paths — a helper whose
     * output failed content validation — restart the helper on purpose, so they cannot read "it
     * quit politely" as a reason to leave a suspect process owning the runtime.
     */
    resetRuntime?: boolean;
    signal?: AbortSignal;
    cause?: unknown;
  } = {},
): Promise<boolean> {
  const session = sessions.get(deviceKey);
  if (!session) return false;
  sessions.delete(deviceKey);
  const processExit = observeAndroidSnapshotHelperProcessExit(session.process);
  const force = options.force === true || options.signal?.aborted === true;
  const graceful = await requestGracefulSessionExit(session, processExit, force, options.signal);
  const hostProcessEnded = processExit.hasEnded();
  // The helper releases UiAutomation inside its own quit handling, so a quit it acknowledged and
  // then completed IS the release evidence — but only where the host exit code it is read from
  // belongs to the device. `exited` separates "the helper said it would quit" from "the helper
  // finished quitting" (see AndroidSnapshotHelperProcessExit); the transport probe separates an
  // exit status adb forwarded from the device from one adb invented for a closed connection.
  // Anything less is not evidence, and the device-side stop runs.
  const deviceExitObserved = graceful.acknowledged && graceful.exited;
  const releaseProvenByQuit =
    deviceExitObserved &&
    (await androidAdbForwardsDeviceExitStatus({
      adb: session.adb,
      deviceKey,
      signal: options.signal,
    }));
  const cleanupTimeoutMs = !force
    ? FORWARD_TIMEOUT_MS
    : options.signal?.aborted === true
      ? ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS
      : ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS;
  const processExitTimeoutMs = force
    ? ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS
    : SESSION_PROCESS_EXIT_TIMEOUT_MS;
  const [processStopped, cleanup] = await Promise.all([
    stopAndroidSnapshotHelperHostProcess({
      process: session.process,
      processExit,
      timeoutMs: processExitTimeoutMs,
    }),
    settleAndroidSnapshotHelperSessionCleanup({
      adb: session.adb,
      process: session.process,
      port: session.port,
      packageName: session.helper.packageName,
      timeoutMs: cleanupTimeoutMs,
      forceStopRuntime: options.resetRuntime === true || !releaseProvenByQuit,
    }),
  ]);
  // Teardown never decides what the command reports: what the device said about ownership is
  // recorded for the next acquire, and a command that already answered stays answered.
  const release = await recordAndroidSnapshotHelperRelease({
    deviceKey,
    packageName: session.helper.packageName,
    adb: session.adb,
    cause: options.cause,
    ...(releaseProvenByQuit ? { release: 'released' as const } : {}),
  });
  emitDiagnostic({
    phase: 'android_snapshot_helper_session_stop',
    data: {
      deviceKey,
      port: session.port,
      capturedCount: session.capturedCount,
      lifetimeMs: Date.now() - session.startedAtMs,
      quitAcknowledged: graceful.acknowledged,
      // With the exit observed but the release unproven, the transport is what failed to prove it.
      quitExitObserved: deviceExitObserved,
      releaseProvenByQuit,
      release,
      forceKilled: !hostProcessEnded && processStopped,
      forced: force || options.signal?.aborted === true,
      externalCleanupTimedOut: cleanup.timedOut,
    },
  });
  return true;
}

async function requestGracefulSessionExit(
  session: AndroidSnapshotHelperSession,
  processExit: AndroidSnapshotHelperProcessExit,
  force: boolean,
  signal: AbortSignal | undefined,
): Promise<{
  acknowledged: boolean;
  /** The instrumentation this teardown asked to quit then finished on its own, cleanly. */
  exited: boolean;
}> {
  if (force) return { acknowledged: false, exited: false };
  const requestId = `quit-${Date.now()}`;
  try {
    const response = await sendAndroidSnapshotHelperSessionCommand(
      session.port,
      `quit ${requestId}`,
      SESSION_STOP_TIMEOUT_MS,
      signal,
    );
    const acknowledged = isAndroidSnapshotHelperSessionCommandAcknowledged(response, requestId);
    const exited =
      acknowledged &&
      (await waitForAndroidSnapshotHelperProcessExit(
        processExit.ended,
        SESSION_GRACEFUL_EXIT_TIMEOUT_MS,
        signal,
      )) &&
      processExit.completedCleanly();
    return { acknowledged, exited };
  } catch {
    return { acknowledged: false, exited: false };
  }
}

export async function stopAndroidSnapshotHelperSessionForDevice(
  device: Pick<DeviceInfo, 'platform' | 'id'>,
): Promise<void> {
  await stopAndroidSnapshotHelperSession(getAndroidSnapshotHelperSessionDeviceKey(device));
}

export async function resetAndroidSnapshotHelperSessions(): Promise<void> {
  try {
    await Promise.allSettled(
      [...sessions.keys()].map(async (deviceKey) => {
        await stopAndroidSnapshotHelperSession(deviceKey);
      }),
    );
  } finally {
    // One teardown that throws must not leave the next caller believing a session, a pending
    // retirement, or a failed start is still standing.
    sessions.clear();
    failedStarts.clear();
    resetAndroidSnapshotHelperRetirements();
    resetAndroidAdbShellProtocolProbes();
  }
}
