import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import {
  androidCaptureFailureReasonDetail,
  androidCaptureFailureReasonFromHelperResult,
} from './snapshot-capture-failure-reason.ts';
import {
  type AndroidInstrumentationProcessRecord,
  readInstrumentationResultBoolean,
  readInstrumentationResultIntegerList,
  readInstrumentationResultNumber,
} from './instrumentation-helper.ts';
import {
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  type AndroidSnapshotHelperCaptureOptions,
  type AndroidSnapshotHelperMetadata,
  type AndroidSnapshotHelperOutput,
} from './snapshot-helper-types.ts';
import type { AndroidAdbProcess } from './adb-executor.ts';

export function allocateAndroidSnapshotHelperSessionPort(): Promise<number> {
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

/**
 * The abstract device socket a session helper binds for a host port. The name derives from the
 * port and carries no secret — the helper admits a connection only after reading the forwarded
 * peer's adbd uid via `LocalSocket.getPeerCredentials()`, before any command byte is read — so the
 * name is a routing label, not a credential, and nothing sensitive travels in argv. The helper
 * derives the same name from its `sessionPort` argument; the two must stay in lockstep.
 */
const SESSION_SOCKET_PREFIX = 'agentdevice-snapshot-helper-';

// The host checks the command before opening a connection. The APK enforces the same byte limit.
// A 64 KiB `fill --text-stdin` value of JSON-escaped control characters encodes to 524,368 Base64
// bytes, and the action and request id follow; SessionPeerPolicy.java owns the full derivation.
export const ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES = 513 * 1024;

export function androidSnapshotHelperSessionSocketName(port: number): string {
  return `${SESSION_SOCKET_PREFIX}${port}`;
}

/** The device-side end of the session forward: the helper's abstract socket, not a device TCP port. */
export function androidSnapshotHelperSessionForwardTarget(port: number): `localabstract:${string}` {
  return `localabstract:${androidSnapshotHelperSessionSocketName(port)}`;
}

export const SESSION_TRANSPORT_UNSUPPORTED_REASON =
  'android_snapshot_helper_session_transport_unsupported';

const SESSION_REQUEST_TIMEOUT_REASON = 'android_snapshot_helper_session_request_timeout';

/** The helper accepted the session request but sent no answer before the command deadline. */
export function isAndroidSnapshotHelperSessionRequestTimeout(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === SESSION_REQUEST_TIMEOUT_REASON;
}

export function sendAndroidSnapshotHelperSessionCommand(
  port: number,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session request timed out', {
          command: command.split(' ', 1)[0],
          timeoutMs,
          port,
          reason: SESSION_REQUEST_TIMEOUT_REASON,
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
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
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

export async function requestAndroidSnapshotHelperSessionSnapshot(params: {
  port: number;
  commandTimeoutMs: number;
  signal?: AbortSignal;
  idleWait?: AndroidSnapshotHelperCaptureOptions['idleWait'];
  commands: ReadonlySet<string>;
}): Promise<AndroidSnapshotHelperOutput> {
  const requestId = `snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestedCommand = {
    full: 'snapshot',
    short: 'snapshot-short-idle',
    none: 'snapshot-immediate',
  }[params.idleWait ?? 'full'];
  const command = params.commands.has(requestedCommand) ? requestedCommand : 'snapshot';
  // The socket waits out the whole command budget the session was given. The device-side
  // `timeoutMs` bounds only the UiAutomation connect wait, not the traversal after it, so a deadline
  // built from that wait plus a fixed overhead cut off slow-but-healthy captures (tester-army/e2e#841).
  const response = await sendAndroidSnapshotHelperSessionCommand(
    params.port,
    `${command} ${requestId}`,
    params.commandTimeoutMs,
    params.signal,
  );
  return parseAndroidSnapshotHelperSessionSnapshotResponse(response, requestId);
}

const SESSION_TRANSPORT = 'localabstract-peer-uid-v1';
const SESSION_READY_TIMEOUT_REASON = 'android_snapshot_helper_session_ready_timeout';
const SESSION_EXITED_BEFORE_READY_REASON = 'android_snapshot_helper_session_exited_before_ready';
const SESSION_READY_MALFORMED_REASON = 'android_snapshot_helper_session_ready_malformed';

type ReadinessOutcome =
  | { kind: 'ready'; commands: ReadonlySet<string> }
  | { kind: 'failed'; error: AppError };

type StatusRecord = { fields: Map<string, string>; malformed: boolean };

function newStatusRecord(): StatusRecord {
  return { fields: new Map(), malformed: false };
}

/** A status line that does not parse, or a key seen twice, makes the whole record malformed. */
function addStatusLine(record: StatusRecord, line: string): void {
  if (line === '') return;
  const field = /^INSTRUMENTATION_STATUS: ([A-Za-z][\w.-]*)=(.*)$/.exec(line);
  if (!field || record.fields.has(field[1]!)) {
    record.malformed = true;
    return;
  }
  record.fields.set(field[1]!, field[2]!);
}

/**
 * Classifies one complete status record. A ready record decides capability only when it is well
 * formed: this protocol, the session port this host launched, no duplicate or unparsed line. Then the
 * authenticated transport makes it ready, and no transport field means the helper predates that
 * transport. Any other ready record is malformed and takes the transient path. A record that is
 * not readiness is ignored, so the wait goes on.
 */
function classifyReadinessRecord(
  statusLine: string,
  record: StatusRecord,
  launchedPort: number,
): ReadinessOutcome | undefined {
  const { fields } = record;
  if (statusLine !== 'INSTRUMENTATION_STATUS_CODE: 2' || fields.get('sessionReady') !== 'true') {
    return undefined;
  }
  const transport = fields.get('sessionTransport');
  if (
    record.malformed ||
    fields.get('agentDeviceProtocol') !== ANDROID_SNAPSHOT_HELPER_PROTOCOL ||
    fields.get('sessionPort') !== String(launchedPort) ||
    (transport !== undefined && transport !== SESSION_TRANSPORT)
  ) {
    return {
      kind: 'failed',
      error: new AppError('COMMAND_FAILED', 'Android snapshot helper readiness is malformed', {
        reason: SESSION_READY_MALFORMED_REASON,
      }),
    };
  }
  if (transport === undefined) {
    return {
      kind: 'failed',
      error: new AppError(
        'COMMAND_FAILED',
        'Android snapshot helper lacks authenticated sessions',
        {
          reason: SESSION_TRANSPORT_UNSUPPORTED_REASON,
        },
      ),
    };
  }
  return {
    kind: 'ready',
    commands: new Set(fields.get('sessionCommands')?.split(',').filter(Boolean)),
  };
}

const SESSION_EXIT_DRAIN_MS = 250;

/** Resolves when the process's streams have closed, or after the drain budget, whichever is first. */
function settleAfterDrain(record: AndroidInstrumentationProcessRecord): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SESSION_EXIT_DRAIN_MS);
    void record.closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Waits for the helper's readiness record. `launchedPort` is the session port this host launched
 * the helper with; a record that reports any other port is not this helper's readiness.
 */
export function waitForAndroidSnapshotHelperSessionReady(
  childProcess: AndroidAdbProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  record: AndroidInstrumentationProcessRecord,
  launchedPort: number,
): Promise<ReadonlySet<string>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session did not become ready', {
          instrumentation: record.current(),
          timeoutMs,
          reason: SESSION_READY_TIMEOUT_REASON,
        }),
      );
    }, timeoutMs);
    const settle = (outcome: ReadinessOutcome) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (outcome.kind === 'ready') resolve(outcome.commands);
      else reject(outcome.error);
    };
    // Instrumentation status records arrive on stdout. Only complete lines from that stream form a
    // record, so an adb warning on stderr cannot split a line.
    let pendingLine = '';
    let statusRecord = newStatusRecord();
    const onStdout = (chunk: Buffer | string) => {
      const lines = (pendingLine + chunk.toString()).split('\n');
      pendingLine = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('INSTRUMENTATION_STATUS_CODE: ')) {
          const outcome = classifyReadinessRecord(line, statusRecord, launchedPort);
          statusRecord = newStatusRecord();
          if (outcome) {
            settle(outcome);
            return;
          }
          continue;
        }
        if (/^INSTRUMENTATION_(CODE|RESULT|ABORTED):/.test(line)) {
          // Another kind of record ends here, so its fields never reach the next status record.
          statusRecord = newStatusRecord();
          continue;
        }
        addStatusLine(statusRecord, line);
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
    childProcess.stdout?.on('data', onStdout);
    childProcess.once('exit', (code, exitSignal) => {
      clearTimeout(timer);
      // The exit result waits for the streams to drain, but not for an adb whose forked server
      // keeps them open; cancellation stays armed until the promise settles.
      void settleAfterDrain(record).then(() => {
        signal?.removeEventListener('abort', onAbort);
        reject(
          new AppError('COMMAND_FAILED', 'Android snapshot helper session exited before ready', {
            exitCode: code,
            signal: exitSignal,
            instrumentation: record.exitResult() ?? record.current(),
            reason: SESSION_EXITED_BEFORE_READY_REASON,
          }),
        );
      });
    });
    childProcess.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

function parseAndroidSnapshotHelperSessionHeaders(response: string): Record<string, string> {
  const separator = response.indexOf('\n\n');
  return parseHeaders(response.slice(0, separator < 0 ? response.length : separator));
}

export function parseAndroidSnapshotHelperSessionTouchResponse(
  response: string,
  requestId: string,
): Record<string, string> {
  const headers = parseAndroidSnapshotHelperSessionHeaders(response);
  if (headers.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper session returned wrong protocol',
      { headers },
    );
  }
  if (headers.requestId !== requestId) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android automation helper session returned stale output',
      { headers, requestId },
    );
  }
  if (!response.includes('\n\n')) {
    throw new AppError('COMMAND_FAILED', 'Android automation helper returned incomplete headers');
  }
  return headers;
}

export function isAndroidSnapshotHelperSessionCommandAcknowledged(
  response: string,
  requestId: string,
): boolean {
  const headers = parseAndroidSnapshotHelperSessionHeaders(response);
  return (
    headers.agentDeviceProtocol === ANDROID_SNAPSHOT_HELPER_PROTOCOL &&
    headers.requestId === requestId &&
    headers.ok === 'true'
  );
}

export function parseAndroidSnapshotHelperSessionSnapshotResponse(
  response: string,
  requestId: string,
): AndroidSnapshotHelperOutput {
  const separator = response.indexOf('\n\n');
  if (separator < 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned malformed output',
      { responseLength: response.length },
    );
  }
  const headers = parseHeaders(response.slice(0, separator));
  const xml = response.slice(separator + 2);
  validateSnapshotHeaders(headers, requestId);
  validateSnapshotXml(headers, xml);
  return { xml, metadata: readSessionMetadata(headers) };
}

function validateSnapshotHeaders(headers: Record<string, string>, requestId: string): void {
  if (headers.agentDeviceProtocol !== ANDROID_SNAPSHOT_HELPER_PROTOCOL) {
    throw new AppError(
      'COMMAND_FAILED',
      'Android snapshot helper session returned wrong protocol',
      { headers },
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
      {
        helper: headers,
        ...androidCaptureFailureReasonDetail(androidCaptureFailureReasonFromHelperResult(headers)),
      },
    );
  }
}

function validateSnapshotXml(headers: Record<string, string>, xml: string): void {
  const byteLength = readInstrumentationResultNumber(headers.byteLength);
  if (byteLength !== undefined && Buffer.byteLength(xml, 'utf8') !== byteLength) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session returned truncated XML', {
      headers,
      actualByteLength: Buffer.byteLength(xml, 'utf8'),
    });
  }
  if (!xml.includes('<hierarchy') || !xml.includes('</hierarchy>')) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper session did not return XML', {
      headers,
      xmlLength: xml.length,
    });
  }
}

function parseHeaders(headerText: string): Record<string, string> {
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
    waitForIdleTimeoutMs: readInstrumentationResultNumber(headers.waitForIdleTimeoutMs),
    waitForIdleQuietMs: readInstrumentationResultNumber(headers.waitForIdleQuietMs),
    timeoutMs: readInstrumentationResultNumber(headers.timeoutMs),
    maxDepth: readInstrumentationResultNumber(headers.maxDepth),
    maxNodes: readInstrumentationResultNumber(headers.maxNodes),
    rootPresent: readInstrumentationResultBoolean(headers.rootPresent),
    cacheInvalidated: readInstrumentationResultBoolean(headers.cacheInvalidated),
    captureMode:
      headers.captureMode === 'interactive-windows' || headers.captureMode === 'active-window'
        ? headers.captureMode
        : undefined,
    windowCount: readInstrumentationResultNumber(headers.windowCount),
    missingRootWindowTypes: readInstrumentationResultIntegerList(headers.missingRootWindowTypes),
    nodeCount: readInstrumentationResultNumber(headers.nodeCount),
    truncated: readInstrumentationResultBoolean(headers.truncated),
    elapsedMs: readInstrumentationResultNumber(headers.elapsedMs),
    pixelDensity: readInstrumentationResultNumber(headers.pixelDensity),
    displayWidth: readInstrumentationResultNumber(headers.displayWidth),
    displayHeight: readInstrumentationResultNumber(headers.displayHeight),
  };
}
