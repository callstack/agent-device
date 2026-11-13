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
  /** Starts watching `phase`. The phase being watched before stops counting. */
  arm(phase: TransferPhase, timeoutMs: number): void;
  /** Records body bytes moving, so only the silence since the last byte counts against a body phase. */
  touchBody(): void;
  /** Stops the armed timer. Call it once the attempt is settled. */
  dispose(): void;
};

export function createTransferPhaseWatchdog(callerSignal?: AbortSignal): TransferPhaseWatchdog {
  const phase = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, phase.signal]) : phase.signal;
  let armed: { phase: TransferPhase; timeoutMs: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rearm = () => {
    if (timer !== undefined) clearTimeout(timer);
    const current = armed;
    if (!current) return;
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
      rearm();
    },
    touchBody() {
      // Unrelated headers, keepalive traffic and timer callbacks are not body progress, and
      // progress in one phase buys no time in another: only a body phase already armed re-arms.
      if (!armed || !BODY_PHASES.has(armed.phase)) return;
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
