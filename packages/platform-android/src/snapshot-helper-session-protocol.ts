import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
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
  ANDROID_SNAPSHOT_HELPER_SESSION_SOCKET_PREFIX,
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

// The host checks the command before opening a connection. The APK enforces the same byte limit.
// A 64 KiB `fill --text-stdin` value of JSON-escaped control characters encodes to 524,368 Base64
// bytes, and the action and request id follow; SessionPeerPolicy.java owns the full derivation.
export const ANDROID_SNAPSHOT_HELPER_SESSION_MAX_COMMAND_BYTES = 513 * 1024;

/**
 * What this host launched one session with: the abstract socket the helper was told to bind, named
 * from the host's forward port. The name is a routing label, not a credential — the helper admits a
 * connection on the forwarded peer's adbd uid — and readiness has to report it for the session to be
 * this launch's session.
 */
export type AndroidSnapshotHelperSessionLaunch = {
  socketName: string;
  forwardTarget: `localabstract:${string}`;
};

/** The one socket name a session launch owns, in the shape `buildAndroidSnapshotHelperArgs` takes. */
export function androidSnapshotHelperSessionLaunchArgs(
  port: number,
): AndroidSnapshotHelperSessionLaunch {
  const socketName = `${ANDROID_SNAPSHOT_HELPER_SESSION_SOCKET_PREFIX}${port}`;
  return { socketName, forwardTarget: `localabstract:${socketName}` };
}
const SESSION_REQUEST_TIMEOUT_REASON = 'android_snapshot_helper_session_request_timeout';

/** The helper accepted the session request but sent no answer before the command deadline. */
export function isAndroidSnapshotHelperSessionRequestTimeout(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === SESSION_REQUEST_TIMEOUT_REASON;
}

/**
 * Where a session listens and the secret its helper reported on stdout at readiness. The secret
 * stays in this process: it never crosses the socket, and no log or error carries it.
 */
export type AndroidSnapshotHelperSessionEndpoint = { port: number; secret: Buffer };

const SESSION_PEER_UNVERIFIED_REASON = 'android_snapshot_helper_session_peer_unverified';

/**
 * The listener did not prove the session secret, so it is not the helper this session launched
 * (another process can bind a freed abstract name). No command byte was sent to it.
 */
export function isAndroidSnapshotHelperSessionPeerUnverified(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === SESSION_PEER_UNVERIFIED_REASON;
}

const SERVER_LABEL = 'agent-device-session-server|';
const CLIENT_LABEL = 'agent-device-session-client|';

function sessionProof(secret: Buffer, label: string, first: string, second: string): string {
  return createHmac('sha256', secret).update(`${label}${first}${second}`).digest('hex');
}

/**
 * Sends one command after a mutual proof of the session secret: the host sends a nonce, the helper
 * answers with its nonce and an HMAC over both, and only a matching proof lets the host send its own
 * proof and then the command. A listener that cannot prove the secret gets the nonce and nothing
 * else.
 */
export function sendAndroidSnapshotHelperSessionCommand(
  endpoint: AndroidSnapshotHelperSessionEndpoint,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const { port, secret } = endpoint;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const clientNonce = randomBytes(32).toString('hex');
    let hello: Buffer | undefined = Buffer.alloc(0);
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
    let refused = false;
    const refuse = () => {
      if (refused) return;
      refused = true;
      cleanup();
      socket.destroy();
      emitDiagnostic({
        level: 'warn',
        phase: SESSION_PEER_UNVERIFIED_REASON,
        data: { port, command: command.split(' ', 1)[0] },
      });
      reject(
        new AppError('COMMAND_FAILED', 'Android snapshot helper session peer is unverified', {
          port,
          reason: SESSION_PEER_UNVERIFIED_REASON,
          dispatched: 'no',
        }),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.on('connect', () => socket.write(`${clientNonce}\n`));
    // Only the helper that printed the secret can answer the nonce; anything else is refused.
    socket.on('data', (chunk) => {
      if (!hello) return void chunks.push(Buffer.from(chunk));
      hello = Buffer.concat([hello, chunk]);
      const newline = hello.indexOf(0x0a);
      if (newline < 0) return void (hello.length > 129 && refuse());
      const [serverNonce = '', proof = ''] = hello
        .subarray(0, newline)
        .toString('latin1')
        .split(' ');
      chunks.push(hello.subarray(newline + 1));
      hello = undefined;
      const expected = Buffer.from(sessionProof(secret, SERVER_LABEL, clientNonce, serverNonce));
      const actual = Buffer.from(proof);
      if (
        !/^[0-9a-f]{64}$/.test(serverNonce) ||
        actual.length !== expected.length ||
        !timingSafeEqual(expected, actual)
      ) {
        return refuse();
      }
      socket.write(`${sessionProof(secret, CLIENT_LABEL, serverNonce, clientNonce)}\n${command}\n`);
    });
    // Before the hello nothing proved the peer, and no command byte has left this process.
    socket.on('error', (error) => {
      if (hello || refused) return refuse();
      cleanup();
      reject(error);
    });
    socket.on('close', () => {
      if (hello || refused) return refuse();
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

export async function requestAndroidSnapshotHelperSessionSnapshot(params: {
  endpoint: AndroidSnapshotHelperSessionEndpoint;
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
    params.endpoint,
    `${command} ${requestId}`,
    params.commandTimeoutMs,
    params.signal,
  );
  return parseAndroidSnapshotHelperSessionSnapshotResponse(response, requestId);
}

const SESSION_READY_TIMEOUT_REASON = 'android_snapshot_helper_session_ready_timeout';
const SESSION_EXITED_BEFORE_READY_REASON = 'android_snapshot_helper_session_exited_before_ready';
const SESSION_READY_MALFORMED_REASON = 'android_snapshot_helper_session_ready_malformed';

type ReadinessOutcome =
  | { kind: 'ready'; commands: ReadonlySet<string>; secret: Buffer }
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
 * Classifies one complete status record. A ready record decides readiness only when it is well
 * formed: this protocol, the socket name this host launched, a 32-byte session secret, no duplicate
 * or unparsed line. Anything
 * else is a start failure, not a capability answer: an older helper refuses the versioned mode
 * before it would report readiness (#4519). A record that is not readiness is ignored, so the wait
 * goes on.
 */
function classifyReadinessRecord(
  statusLine: string,
  record: StatusRecord,
  launchedSocketName: string,
): ReadinessOutcome | undefined {
  const { fields } = record;
  if (statusLine !== 'INSTRUMENTATION_STATUS_CODE: 2' || fields.get('sessionReady') !== 'true') {
    return undefined;
  }
  if (
    record.malformed ||
    fields.get('agentDeviceProtocol') !== ANDROID_SNAPSHOT_HELPER_PROTOCOL ||
    fields.get('sessionSocket') !== launchedSocketName ||
    !/^[0-9a-f]{64}$/.test(fields.get('sessionSecret') ?? '')
  ) {
    return {
      kind: 'failed',
      error: new AppError('COMMAND_FAILED', 'Android snapshot helper readiness is malformed', {
        reason: SESSION_READY_MALFORMED_REASON,
      }),
    };
  }
  return {
    kind: 'ready',
    commands: new Set(fields.get('sessionCommands')?.split(',').filter(Boolean)),
    secret: Buffer.from(fields.get('sessionSecret')!, 'hex'),
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
 * Waits for the helper's readiness record. `launchedSocketName` is the session socket this host
 * launched the helper with; a record that reports any other socket is not this helper's readiness.
 */
export function waitForAndroidSnapshotHelperSessionReady(
  childProcess: AndroidAdbProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  record: AndroidInstrumentationProcessRecord,
  launchedSocketName: string,
): Promise<{ commands: ReadonlySet<string>; secret: Buffer }> {
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
      if (outcome.kind === 'ready') resolve({ commands: outcome.commands, secret: outcome.secret });
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
          const outcome = classifyReadinessRecord(line, statusRecord, launchedSocketName);
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
