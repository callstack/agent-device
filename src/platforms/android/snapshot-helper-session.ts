import net from 'node:net';
import type { AndroidAdbProcess } from './adb-executor.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
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
const SESSION_PROCESS_EXIT_TIMEOUT_MS = 2_000;
const SESSION_REQUEST_OVERHEAD_MS = 10_000;
const FORWARD_TIMEOUT_MS = 5_000;

type AndroidSnapshotHelperSession = {
  identity: string;
  deviceKey: string;
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
  const resolved = resolveAndroidSnapshotHelperCaptureOptions(options);
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
    const output = await requestSessionSnapshot(session, resolved);
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
    await stopAndroidSnapshotHelperSession(deviceKey);
    throw error;
  }
}

export async function stopAndroidSnapshotHelperSession(deviceKey: string): Promise<void> {
  const session = sessions.get(deviceKey);
  if (!session) return;
  sessions.delete(deviceKey);
  try {
    await sendSessionCommand(session, `quit ${Date.now()}`, SESSION_STOP_TIMEOUT_MS);
  } catch {
    // The process may already be gone; adb forward cleanup and kill below are still enough.
  }
  try {
    await session.process.kill('SIGTERM');
  } catch {
    // Best effort. A completed instrumentation process can reject/ignore kill.
  }
  await waitForProcessExit(session.process, SESSION_PROCESS_EXIT_TIMEOUT_MS);
  try {
    await removeForward(session);
  } catch {
    // Stale forwards are harmless and the next start overwrites its chosen local port.
  }
  emitDiagnostic({
    phase: 'android_snapshot_helper_session_stop',
    data: {
      deviceKey,
      port: session.port,
      capturedCount: session.capturedCount,
      lifetimeMs: Date.now() - session.startedAtMs,
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
    port,
    adb: params.options.adb,
    process,
    startedAtMs: Date.now(),
    capturedCount: 0,
  };
  try {
    await waitForSessionReady(process, SESSION_READY_TIMEOUT_MS);
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
    try {
      process.kill('SIGTERM');
    } catch {
      // Best effort after startup failure.
    }
    await waitForProcessExit(process, SESSION_PROCESS_EXIT_TIMEOUT_MS);
    throw error;
  }
}

function waitForProcessExit(process: AndroidAdbProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    process.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    process.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function waitForSessionReady(process: AndroidAdbProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
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
        resolve();
      }
    };
    process.stdout?.on('data', onData);
    process.stderr?.on('data', onData);
    process.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session exited before ready', {
          output,
          exitCode: code,
          signal,
        }),
      );
    });
    process.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function requestSessionSnapshot(
  session: AndroidSnapshotHelperSession,
  resolved: AndroidSnapshotHelperResolvedCaptureOptions,
): Promise<AndroidSnapshotHelperOutput> {
  const requestId = `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // Keep the session request generous enough for slow UIAutomator captures, but never
  // beyond the command budget the caller already assigned to this snapshot.
  const timeoutMs = resolveAndroidSnapshotHelperSessionRequestTimeoutMs(resolved);
  const response = await sendSessionCommand(session, `snapshot ${requestId}`, timeoutMs);
  return parseSessionSnapshotResponse(response, requestId);
}

function sendSessionCommand(
  session: AndroidSnapshotHelperSession,
  command: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: session.port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session request timed out', {
          command,
          timeoutMs,
          port: session.port,
        }),
      );
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${command}\n`);
    });
    socket.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
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
