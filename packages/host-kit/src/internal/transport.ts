import crypto from 'node:crypto';
import { types } from 'node:util';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { AppError } from '@agent-device/kernel/errors';

export function consumeTextLines(
  currentBuffer: string,
  chunk: string | Buffer,
): { lines: string[]; buffer: string } {
  const lines: string[] = [];
  let buffer = currentBuffer + chunk.toString();
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) lines.push(line);
    idx = buffer.indexOf('\n');
  }
  return { lines, buffer };
}
/** The slice of `node:http` / `node:https` an outbound request needs. */
export type NodeHttpRequester = Pick<typeof import('node:http'), 'request'>;

/**
 * Loads `node:http` / `node:https` on demand, at the call site that actually
 * issues a request.
 *
 * Importing either for a VALUE initializes undici and, under
 * `NODE_USE_SYSTEM_CA=1`, the platform trust store -- ~79ms per process. Several
 * modules that only *might* speak HTTP (the daemon transport, remote artifact
 * upload/download) sit in the CLI's eager import closure, where the default
 * daemon transport is a plain `node:net` socket and no HTTP request is ever
 * made. `src/__tests__/cli-startup-import-closure.test.ts` fails the build if a
 * static import of either module reappears in that closure.
 *
 * Resolves `.default`, not the namespace, so callers get the very same module
 * object a static `import http from 'node:http'` yields -- its `request`
 * property is mutable, which the transport tests rely on to stub requests.
 */
export async function loadNodeHttpRequester(protocol: string): Promise<NodeHttpRequester> {
  return protocol === 'https:'
    ? (await import('node:https')).default
    : (await import('node:http')).default;
}

export function readNodeHttpResponseBody(
  res: IncomingMessage,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      onChunk?.(chunk);
      body += chunk;
    });
    res.on('end', () => resolve(body));
    res.on('error', reject);
  });
}

export async function readNodeHttpRequestBody(
  req: IncomingMessage,
  maxBodyBytes: number,
  tooLargeMessage: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodyBytes += buffer.length;
    if (bodyBytes > maxBodyBytes) {
      throw new AppError('INVALID_ARGS', tooLargeMessage);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * Compares two secret strings in constant time. Hashing both inputs first
 * keeps the comparison length-independent, so unequal-length tokens neither
 * throw nor leak length via timing.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Reports successful nonempty write completions as local-kernel acceptance, never peer receipt.
 * Attach at construction. Late response/abort/destroy/dispose completions do not count.
 * Disposal restores this wrapper only; caller arguments, callback and backpressure are preserved.
 */
export function observeCompletedRequestWrites(
  req: ClientRequest,
  signal: AbortSignal,
  onCompleted: () => void,
): () => void {
  const ownWrite = Object.getOwnPropertyDescriptor(req, 'write');
  const write = req.write;
  let observing = true;
  const onResponse = () => {
    observing = false;
  };
  const observedWrite = function (this: ClientRequest, ...args: unknown[]): boolean {
    const [chunk, encoding] = args;
    const callbackIndex = typeof encoding === 'function' ? 1 : 2;
    const callback = args[callbackIndex];
    const encodingName = typeof encoding === 'string' ? encoding.toLowerCase() : undefined;
    const hasBytes =
      typeof chunk === 'string'
        ? encodingName === 'hex' || encodingName === 'base64' || encodingName === 'base64url'
          ? Buffer.from(chunk, encodingName).byteLength > 0
          : chunk.length > 0
        : types.isUint8Array(chunk) && chunk.byteLength > 0;
    if (observing && hasBytes) {
      args[callbackIndex] = (error?: Error | null) => {
        if (!error && observing && !req.destroyed && !signal.aborted) onCompleted();
        if (typeof callback === 'function') callback(error);
      };
    }
    return Reflect.apply(write, this, args);
  };
  req.write = observedWrite;
  // Stop counting writes before the request's response callback runs.
  req.prependListener('response', onResponse);
  return () => {
    observing = false;
    req.off('response', onResponse);
    if (req.write !== observedWrite) return;
    if (ownWrite) Object.defineProperty(req, 'write', ownWrite);
    else Reflect.deleteProperty(req, 'write');
  };
}

export const TRANSFER_CONNECT_TIMEOUT_MS = 30_000;

/** Header wait begins after connection and outgoing flush. */
export const TRANSFER_RESPONSE_HEADER_TIMEOUT_MS = 30_000;

export const TRANSFER_BODY_INACTIVITY_TIMEOUT_MS = 120_000;

export type TransferPhase =
  | 'connect'
  | 'request-body'
  | 'response-headers'
  | 'response-body'
  | 'preflight'
  | 'finalize';

const BODY_PHASES: ReadonlySet<TransferPhase> = new Set(['request-body', 'response-body']);

const TRANSFER_PHASE_TIMEOUT_REASON = 'transfer_phase_timeout';

/** Sequential phases under the earliest caller/aggregate deadline; only body progress rearms. */
export type TransferPhaseWatchdog = {
  signal: AbortSignal;
  arm(phase: TransferPhase, timeoutMs: number): void;
  touchBody(): void;
  /** Stops counting an idle ceiling while the holder waits on demand, keeping its armed phase. */
  suspend(): void;
  /** Stops observing this attempt. A suspended phase stays suspended. */
  dispose(): void;
};

export function createTransferPhaseWatchdog(callerSignal?: AbortSignal): TransferPhaseWatchdog {
  const phase = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, phase.signal]) : phase.signal;
  let armed: { phase: TransferPhase; timeoutMs: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  const rearm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const current = armed;
    if (!current || suspended) return;
    timer = setTimeout(() => {
      timer = undefined;
      phase.abort(createTransferPhaseTimeoutError(current.phase, current.timeoutMs));
    }, current.timeoutMs);
    timer.unref();
  };
  return {
    signal,
    arm(nextPhase, timeoutMs) {
      if (signal.aborted) return;
      suspended = false;
      armed = { phase: nextPhase, timeoutMs };
      rearm();
    },
    touchBody() {
      if (!armed || !BODY_PHASES.has(armed.phase)) return;
      rearm();
    },
    suspend() {
      suspended = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    dispose() {
      armed = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

function createTransferPhaseTimeoutError(phase: TransferPhase, timeoutMs: number): AppError {
  return new AppError('COMMAND_FAILED', `Artifact transfer ${phase} timed out`, {
    reason: TRANSFER_PHASE_TIMEOUT_REASON,
    transferPhase: phase,
    timeoutMs,
  });
}

export function isTransferPhaseTimeoutError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === TRANSFER_PHASE_TIMEOUT_REASON;
}

export type ClientRequestPhases = {
  readonly responseStarted: boolean;
  dispose(): void;
};

/**
 * Attach at construction after arming connect. Headers need connection and request finish.
 * TLS needs secureConnect; pooled sockets are connected. Buffered bytes are not progress.
 * The caller reports body bytes; response start retires request events. Dispose at settlement.
 */
export function observeClientRequestPhases(
  req: ClientRequest,
  watchdog: TransferPhaseWatchdog,
): ClientRequestPhases {
  let established = false;
  let flushed = false;
  let responseStarted = false;
  let socket: Socket | undefined;
  let connectEvent: 'connect' | 'secureConnect' | undefined;
  const advance = () => {
    if (responseStarted || watchdog.signal.aborted || !established) return;
    if (flushed) {
      watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
    } else {
      watchdog.arm('request-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
    }
  };
  const onConnected = () => {
    established = true;
    advance();
  };
  const onSocket = (next: Socket) => {
    if (!next.connecting) {
      established = true;
      advance();
      return;
    }
    socket = next;
    const secured = (next as { encrypted?: boolean }).encrypted === true;
    connectEvent = secured ? 'secureConnect' : 'connect';
    next.once(connectEvent, onConnected);
  };
  const onFinish = () => {
    flushed = true;
    advance();
  };
  const onResponse = () => {
    responseStarted = true;
    watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
  };
  req.on('socket', onSocket);
  req.on('finish', onFinish);
  req.prependListener('response', onResponse);
  return {
    get responseStarted() {
      return responseStarted;
    },
    dispose() {
      req.off('socket', onSocket);
      req.off('finish', onFinish);
      req.off('response', onResponse);
      if (socket && connectEvent) socket.off(connectEvent, onConnected);
    },
  };
}
