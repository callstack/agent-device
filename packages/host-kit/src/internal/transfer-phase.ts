import type { ClientRequest } from 'node:http';
import type { Socket } from 'node:net';
import { AppError } from '@agent-device/kernel/errors';

/**
 * Ceiling for establishing the connection one artifact-transfer attempt runs on.
 *
 * Kept beside its domain rather than on the socket: the same number governs every hop of an upload,
 * every offset resume and a standalone artifact download, so "how long may one hop take to connect"
 * has exactly one answer.
 */
export const TRANSFER_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Ceiling for waiting on response headers once this side has written everything the server is
 * waiting for. For an upload that is the moment its outgoing request body is fully flushed, never
 * the moment the request was created; for a bodyless request it is connection establishment.
 */
export const TRANSFER_RESPONSE_HEADER_TIMEOUT_MS = 30_000;

/**
 * Ceiling for silence between body bytes in either direction. Bytes actually written or read reset
 * it, so an artifact that keeps moving keeps its budget while a connection that stopped carrying
 * bytes does not. Progress never touches the aggregate budget the attempt runs under.
 */
export const TRANSFER_BODY_INACTIVITY_TIMEOUT_MS = 120_000;

export type TransferPhase = 'connect' | 'request-body' | 'response-headers' | 'response-body';

const BODY_PHASES: ReadonlySet<TransferPhase> = new Set(['request-body', 'response-body']);

/** The `details.reason` every phase expiry carries, so no consumer has to match error text. */
export const TRANSFER_PHASE_TIMEOUT_REASON = 'transfer_phase_timeout';

/**
 * Watches the sequential phases of ONE transfer attempt.
 *
 * One attempt gets one watchdog: arming a later phase stops counting the earlier one, so the ceiling
 * that applies is always the phase the transfer is actually in. Progress re-arms only the two body
 * phases. Nothing here extends an enclosing aggregate budget — the caller's signal is combined in,
 * never replaced, so the earliest deadline still wins and every attempt, redirect and resume keeps
 * sharing the original aggregate.
 */
export type TransferPhaseWatchdog = {
  /** The signal the attempt runs on: the caller's cancellation plus every phase deadline. */
  signal: AbortSignal;
  /** Starts watching `phase` and resumes phase timing if it was suspended. The phase watched before stops counting. */
  arm(phase: TransferPhase, timeoutMs: number): void;
  /** Records body bytes moving, so only the silence since the last byte counts against a body phase. */
  touchBody(): void;
  /**
   * Stops the armed phase's timer while this side owes the peer nothing, such as a consumer that has
   * not asked for more bytes. The attempt stays live: the signal, the caller's cancellation and any
   * enclosing aggregate are untouched, and late progress does not restart the timer. Only `arm`
   * resumes phase timing. Unlike `dispose`, it does not mean the attempt is settled.
   */
  suspend(): void;
  /** Stops the armed timer. Call it once the attempt is settled. */
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
      armed = { phase: nextPhase, timeoutMs };
      suspended = false;
      rearm();
    },
    touchBody() {
      // Unrelated headers, keepalive traffic and timer callbacks are not body progress, and
      // progress in one phase buys no time in another: only a body phase already armed re-arms.
      if (!armed || !BODY_PHASES.has(armed.phase)) return;
      rearm();
    },
    suspend() {
      suspended = true;
      rearm();
    },
    dispose() {
      armed = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Typed evidence that a transfer phase, rather than the caller or the whole preparation aggregate,
 * ended the attempt. The expired phase and its effective budget travel in `details`.
 */
export function createTransferPhaseTimeoutError(phase: TransferPhase, timeoutMs: number): AppError {
  return new AppError('COMMAND_FAILED', `Artifact transfer ${phase} timed out`, {
    reason: TRANSFER_PHASE_TIMEOUT_REASON,
    transferPhase: phase,
    timeoutMs,
  });
}

/** Whether `error` is a transfer phase's own expiry, which no fallback or retry may restart. */
export function isTransferPhaseTimeoutError(error: unknown): boolean {
  return error instanceof AppError && error.details?.reason === TRANSFER_PHASE_TIMEOUT_REASON;
}

/** What `observeClientRequestPhases` reports and owns for one outgoing request. */
export type ClientRequestPhases = {
  /** Whether the response has started. Request-side events no longer move the phase after this. */
  readonly responseStarted: boolean;
  /** Removes every listener the observer added. Call it once the exchange is settled. */
  dispose(): void;
};

/**
 * Drives `watchdog` through the phases of ONE outgoing `node:http` request.
 *
 * The caller arms `connect` before issuing the request. From the events that follow, this owner
 * decides the phase the exchange is in:
 * - A fresh socket is not a connection until `connect`, or `secureConnect` for TLS. A pooled socket
 *   already is. Until then the connect ceiling keeps counting, even when the whole body already sits
 *   in the write buffer, because buffered bytes are not transport progress.
 * - A connected exchange that is still writing is in `request-body`. `drain` is the progress that
 *   restarts its inactivity budget, since it reports bytes the socket actually accepted.
 * - The header wait starts only after BOTH the request `finish` and the connection.
 * - Once the response starts, the exchange is in `response-body` and no later request event can
 *   overwrite it. The caller reports response bytes with `touchBody`.
 *
 * Attach it in the tick that creates the request. It waits on nothing: every listener it adds is
 * removed by `dispose`.
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
  const onDrain = () => {
    if (!responseStarted) watchdog.touchBody();
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
  req.on('drain', onDrain);
  req.on('finish', onFinish);
  // The request's own response callback is registered first, so the phase has to move before it runs.
  req.prependListener('response', onResponse);
  return {
    get responseStarted() {
      return responseStarted;
    },
    dispose() {
      req.off('socket', onSocket);
      req.off('drain', onDrain);
      req.off('finish', onFinish);
      req.off('response', onResponse);
      if (socket && connectEvent) socket.off(connectEvent, onConnected);
    },
  };
}
