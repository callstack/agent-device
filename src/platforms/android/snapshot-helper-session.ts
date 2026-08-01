import type { AndroidAdbProcess } from './adb-executor.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import {
  type AndroidAdbExecutor,
  type AndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperOutput,
} from './snapshot-helper-types.ts';
import {
  buildAndroidSnapshotHelperArgs,
  resolveAndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperResolvedCaptureOptions,
} from './snapshot-helper-capture.ts';
import {
  allocateAndroidSnapshotHelperSessionPort,
  assertAndroidSnapshotHelperTouchSessionHeaders,
  isAndroidSnapshotHelperSessionCommandAcknowledged,
  parseAndroidSnapshotHelperSessionHeaders,
  requestAndroidSnapshotHelperSessionSnapshot,
  sendAndroidSnapshotHelperSessionCommand,
  waitForAndroidSnapshotHelperSessionReady,
} from './snapshot-helper-session-protocol.ts';
import {
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
export {
  getAndroidSnapshotHelperSessionDeviceKey,
  isAndroidSnapshotHelperRetirementUnconfirmedError,
  recoverAndroidSnapshotHelperRetirement,
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

type AndroidSnapshotHelperSessionHelperIdentity = {
  packageName: string;
  runner: string;
  helperVersion?: string;
  helperVersionCode?: number;
  sha256?: string;
};

type AndroidSnapshotHelperSession = {
  identity: string;
  deviceKey: string;
  helper: AndroidSnapshotHelperSessionHelperIdentity;
  port: number;
  adb: AndroidAdbExecutor;
  process: AndroidAdbProcess;
  startedAtMs: number;
  capturedCount: number;
};

const sessions = new Map<string, AndroidSnapshotHelperSession>();
const disabledSessionIdentities = new Map<string, string>();

export async function captureAndroidSnapshotWithHelperSession(
  options: AndroidSnapshotHelperCaptureOptions,
): Promise<AndroidSnapshotHelperOutput | undefined> {
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
  if (!session) return undefined;
  return await captureFromAndroidSnapshotHelperSession({
    session,
    deviceKey,
    options,
    resolved,
  });
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

async function captureFromAndroidSnapshotHelperSession(params: {
  session: AndroidSnapshotHelperSession;
  deviceKey: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
}): Promise<AndroidSnapshotHelperOutput | undefined> {
  const { session, deviceKey, options, resolved } = params;
  try {
    const reused = session.capturedCount > 0;
    const output = await requestAndroidSnapshotHelperSessionSnapshot({
      port: session.port,
      timeoutMs: resolved.timeoutMs,
      commandTimeoutMs: resolved.commandTimeoutMs,
      signal: options.signal,
    });
    session.capturedCount += 1;
    return {
      xml: output.xml,
      metadata: {
        ...output.metadata,
        transport: 'persistent-session',
        sessionReused: reused,
      },
    };
  } catch (error) {
    await stopAndroidSnapshotHelperSession(deviceKey, {
      force: true,
      signal: options.signal,
      cause: error,
    });
    options.signal?.throwIfAborted();
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_fallback',
      data: {
        deviceKey,
        reason: error instanceof Error ? error.message : String(error),
        uiAutomationConnectionTimeout: isUiAutomationConnectionTimeoutResponse(error),
      },
    });
    return undefined;
  }
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

function isUiAutomationConnectionTimeoutResponse(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  const helper = error.details?.helper;
  if (!helper || typeof helper !== 'object') return false;
  return (helper as Record<string, unknown>).errorType === 'java.util.concurrent.TimeoutException';
}

// Touch commands piggyback on a live snapshot session so gestures do not restart instrumentation
// (Android permits one UiAutomation owner). They never start a session: without one, callers use
// the same helper APK through a one-shot `am instrument` run instead.
export async function runAndroidSnapshotHelperSessionTouchCommand(params: {
  deviceKey: string;
  action: 'gesture' | 'viewport';
  helper: AndroidSnapshotHelperSessionHelperIdentity;
  payloadBase64?: string;
  timeoutMs: number;
}): Promise<Record<string, string> | undefined> {
  const session = sessions.get(params.deviceKey);
  if (!session) return undefined;
  if (!matchesSessionHelperIdentity(session.helper, params.helper)) {
    // A different helper binary was selected for this device (e.g. a provider-supplied artifact).
    // The live session belongs to the previous helper, so stop it and let the touch command run
    // one-shot against the selected artifact; the next snapshot restarts the session with it.
    emitDiagnostic({
      level: 'warn',
      phase: 'android_snapshot_helper_session_touch_identity_mismatch',
      data: {
        deviceKey: params.deviceKey,
        sessionHelper: session.helper,
        requestedHelper: params.helper,
      },
    });
    await stopAndroidSnapshotHelperSession(params.deviceKey);
    return undefined;
  }
  const requestId = `${params.action}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const command = params.payloadBase64
    ? `${params.action} ${requestId} ${params.payloadBase64}`
    : `${params.action} ${requestId}`;
  let headers: Record<string, string>;
  try {
    const response = await sendAndroidSnapshotHelperSessionCommand(
      session.port,
      command,
      params.timeoutMs,
    );
    headers = parseAndroidSnapshotHelperSessionHeaders(response);
    assertAndroidSnapshotHelperTouchSessionHeaders(headers, requestId);
  } catch (error) {
    // Transport-level failure: the session process can no longer be trusted. Stop it so the next
    // command runs against a fresh helper instead of a wedged socket.
    await stopAndroidSnapshotHelperSession(params.deviceKey);
    throw error;
  }
  if (headers.ok !== 'true') {
    // The helper ran and reported a structured failure; the session itself stays healthy.
    throw new AppError(
      'COMMAND_FAILED',
      headers.message || headers.errorType || `Android automation helper ${params.action} failed`,
      { errorType: headers.errorType, helper: headers },
    );
  }
  return headers;
}

function matchesSessionHelperIdentity(
  session: AndroidSnapshotHelperSessionHelperIdentity,
  requested: AndroidSnapshotHelperSessionHelperIdentity,
): boolean {
  return (
    session.packageName === requested.packageName &&
    session.runner === requested.runner &&
    matchesWhenBothDefined(session.helperVersion, requested.helperVersion) &&
    matchesWhenBothDefined(session.helperVersionCode, requested.helperVersionCode) &&
    matchesWhenBothDefined(session.sha256, requested.sha256)
  );
}

function matchesWhenBothDefined<Value>(a: Value | undefined, b: Value | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

export async function stopAndroidSnapshotHelperSession(
  deviceKey: string,
  options: { force?: boolean; signal?: AbortSignal; cause?: unknown } = {},
): Promise<void> {
  const session = sessions.get(deviceKey);
  if (!session) return;
  sessions.delete(deviceKey);
  const processExit = observeAndroidSnapshotHelperProcessExit(session.process);
  const force = options.force === true || options.signal?.aborted === true;
  const graceful = await requestGracefulSessionExit(session, processExit, force, options.signal);
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
      alreadyExited: graceful.exited,
      timeoutMs: processExitTimeoutMs,
    }),
    settleAndroidSnapshotHelperSessionCleanup({
      adb: session.adb,
      process: session.process,
      port: session.port,
      packageName: session.helper.packageName,
      timeoutMs: cleanupTimeoutMs,
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
      forceKilled: !graceful.exited && processStopped,
      forced: force || options.signal?.aborted === true,
      runtimeForceStopped: cleanup.runtimeForceStopped,
      externalCleanupTimedOut: cleanup.timedOut,
    },
  });
  if (!graceful.exited && !cleanup.runtimeForceStopped) {
    quarantineAndroidSnapshotHelperRetirement({
      deviceKey,
      packageName: session.helper.packageName,
      cause: options.cause,
    });
  }
}

async function requestGracefulSessionExit(
  session: AndroidSnapshotHelperSession,
  processExit: Promise<void>,
  force: boolean,
  signal: AbortSignal | undefined,
): Promise<{ acknowledged: boolean; exited: boolean }> {
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
        processExit,
        SESSION_GRACEFUL_EXIT_TIMEOUT_MS,
        signal,
      ));
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
        processExit,
        ANDROID_SNAPSHOT_HELPER_HOST_PROCESS_EXIT_GRACE_MS,
      ),
      settleAndroidSnapshotHelperSessionCleanup({
        adb: session.adb,
        process: session.process,
        port: session.port,
        packageName: session.helper.packageName,
        timeoutMs: ANDROID_SNAPSHOT_HELPER_DEVICE_RETIREMENT_TIMEOUT_MS,
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

function isAndroidSnapshotHelperSessionEnabled(): boolean {
  const value = process.env.AGENT_DEVICE_ANDROID_SNAPSHOT_HELPER_SESSION;
  return value === undefined || !/^(0|false|no|off)$/i.test(value);
}
