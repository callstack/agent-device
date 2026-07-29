import net from 'node:net';
import type { AndroidAdbProcess } from './adb-executor.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import {
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  type AndroidAdbExecutor,
  type AndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperMetadata,
  type AndroidSnapshotHelperOutput,
} from './snapshot-helper-types.ts';
import {
  buildAndroidSnapshotHelperArgs,
  readAndroidSnapshotHelperMetadataBoolean,
  readAndroidSnapshotHelperMetadataNumber,
  resolveAndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperResolvedCaptureOptions,
} from './snapshot-helper-capture.ts';

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
  if (!isAndroidSnapshotHelperSessionEnabled() || !options.adbProvider?.spawn) {
    return undefined;
  }
  const resolved = resolvePersistentSessionCaptureOptions(
    resolveAndroidSnapshotHelperCaptureOptions(options),
  );
  const deviceKey = options.deviceKey ?? 'android:default';
  const identity = createSessionIdentity(deviceKey, resolved, options);
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
      return undefined;
    }
  }
  try {
    const reused = session.capturedCount > 0;
    const output = await requestSessionSnapshot(session, resolved, options.signal);
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
      force: options.signal?.aborted === true || isUiAutomationConnectionTimeoutResponse(error),
      signal: options.signal,
    });
    throw error;
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
    const response = await sendSessionCommand(session, command, params.timeoutMs);
    headers = parseSessionHeaders(response.slice(0, findSessionHeaderEnd(response)));
    assertTouchSessionHeaders(headers, requestId);
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

function findSessionHeaderEnd(response: string): number {
  const separator = response.indexOf('\n\n');
  return separator < 0 ? response.length : separator;
}

function assertTouchSessionHeaders(headers: Record<string, string>, requestId: string): void {
  if (headers.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper session returned wrong protocol',
      {
        headers,
      },
    );
  }
  if (headers.requestId !== requestId) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper session returned stale output',
      {
        headers,
        requestId,
      },
    );
  }
}

export async function stopAndroidSnapshotHelperSession(
  deviceKey: string,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const session = sessions.get(deviceKey);
  if (!session) return;
  sessions.delete(deviceKey);
  const processExit = observeProcessExit(session.process);
  const quitRequestId = `quit-${Date.now()}`;
  let quitAcknowledged = false;
  const force = options.force === true || options.signal?.aborted === true;
  if (!force) {
    try {
      const response = await sendSessionCommand(
        session,
        `quit ${quitRequestId}`,
        SESSION_STOP_TIMEOUT_MS,
        options.signal,
      );
      quitAcknowledged = isSessionCommandAcknowledged(response, quitRequestId);
    } catch {
      // The process may already be gone; adb forward cleanup and kill below are still enough.
    }
  }
  const exitedGracefully =
    !force &&
    quitAcknowledged &&
    (await waitForProcessExit(processExit, SESSION_GRACEFUL_EXIT_TIMEOUT_MS, options.signal));
  if (!exitedGracefully) {
    try {
      session.process.kill('SIGTERM');
    } catch {
      // Best effort. A completed instrumentation process can reject/ignore kill.
    }
    await waitForProcessExit(processExit, SESSION_PROCESS_EXIT_TIMEOUT_MS);
  }
  const [runtimeStopResult] = await Promise.allSettled([
    forceStopSessionHelperRuntime(session),
    removeForward(session),
  ]);
  const runtimeForceStopped =
    runtimeStopResult.status === 'fulfilled' ? runtimeStopResult.value : false;
  emitDiagnostic({
    phase: 'android_snapshot_helper_session_stop',
    data: {
      deviceKey,
      port: session.port,
      capturedCount: session.capturedCount,
      lifetimeMs: Date.now() - session.startedAtMs,
      quitAcknowledged,
      forceKilled: !exitedGracefully,
      forced: force || options.signal?.aborted === true,
      runtimeForceStopped,
    },
  });
}

export async function stopAndroidSnapshotHelperSessionForDevice(
  device: Pick<DeviceInfo, 'platform' | 'id'>,
): Promise<void> {
  await stopAndroidSnapshotHelperSession(getAndroidSnapshotHelperSessionDeviceKey(device));
}

export function getAndroidSnapshotHelperSessionDeviceKey(
  device: Pick<DeviceInfo, 'platform' | 'id'>,
): string {
  return `${device.platform}:${device.id}`;
}

// This pure seam verifies timeout budgets without making unit tests wait for real time.
export function resolveAndroidSnapshotHelperSessionRequestTimeoutMs(params: {
  timeoutMs: number;
  commandTimeoutMs: number;
}): number {
  return Math.min(
    params.commandTimeoutMs,
    Math.max(params.timeoutMs + SESSION_REQUEST_OVERHEAD_MS, 3_000),
  );
}

/**
 * @internal Test isolation hook for persistent snapshot helper sessions.
 */
export async function resetAndroidSnapshotHelperSessions(): Promise<void> {
  await Promise.all(
    [...sessions.keys()].map((deviceKey) => stopAndroidSnapshotHelperSession(deviceKey)),
  );
  disabledSessionIdentities.clear();
}

async function startAndroidSnapshotHelperSession(params: {
  deviceKey: string;
  identity: string;
  options: AndroidSnapshotHelperCaptureOptions;
  resolved: AndroidSnapshotHelperResolvedCaptureOptions;
}): Promise<AndroidSnapshotHelperSession> {
  const port = await getFreePort();
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
    await waitForSessionReady(process, SESSION_READY_TIMEOUT_MS, params.options.signal);
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
    await removeForward(session);
    const processExit = observeProcessExit(process);
    try {
      process.kill('SIGTERM');
    } catch {
      // Best effort after startup failure.
    }
    await waitForProcessExit(processExit, SESSION_PROCESS_EXIT_TIMEOUT_MS);
    throw error;
  }
}

function observeProcessExit(process: AndroidAdbProcess): Promise<void> {
  if (process.exitCode != null || process.signalCode != null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    process.once('close', () => {
      resolve();
    });
    process.once('exit', () => {
      resolve();
    });
  });
}

async function waitForProcessExit(
  processExit: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const exited = await Promise.race([
    processExit.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
    ...(signal
      ? [
          new Promise<false>((resolve) => {
            onAbort = () => resolve(false);
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ]
      : []),
  ]);
  if (timer) clearTimeout(timer);
  if (onAbort) signal?.removeEventListener('abort', onAbort);
  return exited;
}

function waitForSessionReady(
  process: AndroidAdbProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session did not become ready', {
          output,
          timeoutMs,
        }),
      );
    }, timeoutMs);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (
        output.includes(`agentDeviceProtocol=${ANDROID_SNAPSHOT_HELPER_PROTOCOL}`) &&
        output.includes('sessionReady=true')
      ) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    process.stdout?.on('data', onData);
    process.stderr?.on('data', onData);
    process.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session exited before ready', {
          output,
          exitCode: code,
          signal: exitSignal,
        }),
      );
    });
    process.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

async function requestSessionSnapshot(
  session: AndroidSnapshotHelperSession,
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
  signal?: AbortSignal,
): Promise<AndroidSnapshotHelperOutput> {
  const requestId = `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Keep the session request generous enough for slow UIAutomator captures, but never
  // beyond the command budget the caller already assigned to this snapshot.
  const timeoutMs = resolveAndroidSnapshotHelperSessionRequestTimeoutMs(resolved);
  const response = await sendSessionCommand(session, `snapshot ${requestId}`, timeoutMs, signal);
  return parseSessionSnapshotResponse(response, requestId);
}

function sendSessionCommand(
  session: AndroidSnapshotHelperSession,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: session.port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session request timed out', {
          command,
          timeoutMs,
          port: session.port,
        }),
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      socket.destroy();
      reject(signal?.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.on('connect', () => {
      socket.write(`${command}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on('error', (error) => {
      cleanup();
      reject(error);
    });
    socket.on('close', () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function isSessionCommandAcknowledged(response: string, requestId: string): boolean {
  const headers = parseSessionHeaders(response.slice(0, findSessionHeaderEnd(response)));
  return (
    headers.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL &&
    headers.requestId === requestId &&
    headers.ok === 'true'
  );
}

function parseSessionSnapshotResponse(
  response: string,
  requestId: string,
): AndroidSnapshotHelperOutput {
  const { headers, xml } = splitSessionResponse(response);
  validateSessionHeaders(headers, requestId);
  validateSessionXml(headers, xml);
  return { xml, metadata: readSessionMetadata(headers) };
}

function splitSessionResponse(response: string): { headers: Record<string, string>; xml: string } {
  const separator = response.indexOf('\n\n');
  if (separator < 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned malformed output',
      {
        response,
      },
    );
  }
  return {
    headers: parseSessionHeaders(response.slice(0, separator)),
    xml: response.slice(separator + 2),
  };
}

function validateSessionHeaders(headers: Record<string, string>, requestId: string): void {
  if (headers.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned wrong protocol',
      {
        headers,
      },
    );
  }
  if (headers.outputFormat !== ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned wrong output format',
      { headers },
    );
  }
  if (headers.requestId !== requestId) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session returned stale output', {
      headers,
      requestId,
    });
  }
  if (headers.ok !== 'true') {
    throw new AppError(
      'COMMAND_FAILED',
      headers.message || headers.errorType || 'Android snapshot helper session returned an error',
      { helper: headers },
    );
  }
}

function validateSessionXml(headers: Record<string, string>, xml: string): void {
  const byteLength = readAndroidSnapshotHelperMetadataNumber(headers.byteLength);
  if (byteLength !== undefined && Buffer.byteLength(xml, 'utf8') !== byteLength) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session returned truncated XML', {
      headers,
      actualByteLength: Buffer.byteLength(xml, 'utf8'),
    });
  }
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session did not return XML', {
      headers,
      xml,
    });
  }
}

function parseSessionHeaders(headerText: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerText.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    headers[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return headers;
}

function readSessionMetadata(headers: Record<string, string>): AndroidSnapshotHelperMetadata {
  return {
    helperApiVersion: headers.helperApiVersion,
    outputFormat: ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    waitForIdleTimeoutMs: readAndroidSnapshotHelperMetadataNumber(headers.waitForIdleTimeoutMs),
    waitForIdleQuietMs: readAndroidSnapshotHelperMetadataNumber(headers.waitForIdleQuietMs),
    timeoutMs: readAndroidSnapshotHelperMetadataNumber(headers.timeoutMs),
    maxDepth: readAndroidSnapshotHelperMetadataNumber(headers.maxDepth),
    maxNodes: readAndroidSnapshotHelperMetadataNumber(headers.maxNodes),
    rootPresent: readAndroidSnapshotHelperMetadataBoolean(headers.rootPresent),
    captureMode:
      headers.captureMode === 'interactive-windows' || headers.captureMode === 'active-window'
        ? headers.captureMode
        : undefined,
    windowCount: readAndroidSnapshotHelperMetadataNumber(headers.windowCount),
    nodeCount: readAndroidSnapshotHelperMetadataNumber(headers.nodeCount),
    truncated: readAndroidSnapshotHelperMetadataBoolean(headers.truncated),
    elapsedMs: readAndroidSnapshotHelperMetadataNumber(headers.elapsedMs),
  };
}

async function removeForward(session: AndroidSnapshotHelperSession): Promise<void> {
  await session.process.stdin?.end();
  await session.process.stdout?.destroy();
  await session.process.stderr?.destroy();
  await sessionForwardRemove(session);
}

async function sessionForwardRemove(session: AndroidSnapshotHelperSession): Promise<void> {
  await session.adb(['forward', '--remove', `tcp:${session.port}`], {
    allowFailure: true,
    timeoutMs: FORWARD_TIMEOUT_MS,
  });
}

async function forceStopSessionHelperRuntime(
  session: AndroidSnapshotHelperSession,
): Promise<boolean> {
  try {
    const result = await session.adb(['shell', 'am', 'force-stop', session.helper.packageName], {
      allowFailure: true,
      timeoutMs: FORWARD_TIMEOUT_MS,
    });
    return result.exitCode === 0;
  } catch {
    return false;
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

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local TCP port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
