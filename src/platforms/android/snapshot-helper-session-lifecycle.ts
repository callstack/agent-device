/**
 * Who owns the device's UiAutomation right now, and how that ownership starts and ends.
 *
 * Android permits ONE UiAutomation owner, so a live helper session is device-exclusive state: this
 * module is the only place that starts one, hands it out, and retires it. Commands run OVER a
 * session (snapshot capture, gestures) live in `snapshot-helper-session.ts`; they acquire through
 * here and never reach the registry themselves.
 */
import type { AndroidAdbProcess } from './adb-executor.ts';
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
  isAndroidSnapshotHelperRetirementUnconfirmedError,
  observeAndroidSnapshotHelperProcessExit,
  quarantineAndroidSnapshotHelperRetirement,
  recoverAndroidSnapshotHelperRetirement,
  resetAndroidSnapshotHelperRetirements,
  settleAndroidSnapshotHelperSessionCleanup,
  stopAndroidSnapshotHelperHostProcess,
  waitForAndroidSnapshotHelperProcessExit,
} from './snapshot-helper-retirement.ts';

const SESSION_READY_TIMEOUT_MS = 10_000;
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
const disabledSessionIdentities = new Map<string, string>();

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
  const resolved = resolvePersistentSessionCaptureOptions(
    resolveAndroidSnapshotHelperCaptureOptions(options),
  );
  const identity = createSessionIdentity(deviceKey, resolved, options);
  const session = await resolveAndroidSnapshotHelperSession({
    deviceKey,
    identity,
    options,
    resolved,
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
}): Promise<AndroidSnapshotHelperSession | undefined> {
  const { deviceKey, identity, options, resolved } = params;
  if (disabledSessionIdentities.get(deviceKey) === identity) {
    return undefined;
  }
  let session = sessions.get(deviceKey);
  if (session && session.identity !== identity) {
    await stopAndroidSnapshotHelperSession(deviceKey);
    session = undefined;
  }
  if (!session) {
    try {
      session = await startAndroidSnapshotHelperSession({
        deviceKey,
        identity,
        options,
        resolved,
      });
    } catch (error) {
      options.signal?.throwIfAborted();
      disabledSessionIdentities.set(deviceKey, identity);
      emitDiagnostic({
        level: 'warn',
        phase: 'android_snapshot_helper_session_disabled',
        data: {
          deviceKey,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
      if (isAndroidSnapshotHelperRetirementUnconfirmedError(error)) {
        throw error;
      }
      return undefined;
    }
  }
  return session;
}

async function startAndroidSnapshotHelperSession(params: {
  deviceKey: string;
  identity: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
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
  const runner = args[args.length - 1];
  if (!runner) {
    throw new AppError('INVALID_ARGS', 'Android snapshot helper runner was not resolved');
  }
  const sessionArgs = [...args.slice(0, -1), '-e', 'sessionPort', String(port), runner];
  const process = params.options.adbProvider!.spawn!(sessionArgs, {
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
    process,
    startedAtMs: Date.now(),
    capturedCount: 0,
  };
  try {
    await waitForAndroidSnapshotHelperSessionReady(
      process,
      SESSION_READY_TIMEOUT_MS,
      params.options.signal,
    );
    sessions.set(params.deviceKey, session);
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
    const processExit = observeAndroidSnapshotHelperProcessExit(process);
    try {
      process.kill('SIGTERM');
    } catch {
      // Best effort after startup failure.
    }
    const [, cleanup] = await Promise.all([
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
    if (!cleanup.runtimeForceStopped) {
      quarantineAndroidSnapshotHelperRetirement({
        deviceKey: params.deviceKey,
        packageName: session.helper.packageName,
        cause: error,
      });
    }
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

function isAndroidSnapshotHelperSessionEnabled(): boolean {
  const value = process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
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
  const runtimeReleaseConfirmed =
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
      forceStopRuntime: options.resetRuntime === true || !runtimeReleaseConfirmed,
    }),
  ]);
  emitDiagnostic({
    phase: 'android_snapshot_helper_session_stop',
    data: {
      deviceKey,
      port: session.port,
      capturedCount: session.capturedCount,
      lifetimeMs: Date.now() - session.startedAtMs,
      quitAcknowledged: graceful.acknowledged,
      // With the exit observed but the release unconfirmed, the transport is what failed to prove it.
      quitExitObserved: deviceExitObserved,
      runtimeReleaseConfirmed,
      forceKilled: !hostProcessEnded && processStopped,
      forced: force || options.signal?.aborted === true,
      runtimeForceStopped: cleanup.runtimeForceStopped,
      externalCleanupTimedOut: cleanup.timedOut,
    },
  });
  // Either the release was proven or the device-side stop confirmed it. An unproven quit whose
  // stop also failed leaves ownership unknown, which is what quarantine exists to report.
  if (!runtimeReleaseConfirmed && !cleanup.runtimeForceStopped) {
    quarantineAndroidSnapshotHelperRetirement({
      deviceKey,
      packageName: session.helper.packageName,
      cause: options.cause,
    });
  }
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
  const retirements = await Promise.allSettled(
    [...sessions.keys()].map((deviceKey) => stopAndroidSnapshotHelperSession(deviceKey)),
  );
  disabledSessionIdentities.clear();
  const failures = retirements
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to retire every Android snapshot helper session');
  }
  resetAndroidSnapshotHelperRetirements();
  resetAndroidAdbShellProtocolProbes();
}
