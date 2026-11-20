import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { TRANSFER_BODY_INACTIVITY_TIMEOUT_MS } from '@agent-device/host-kit/transport';
import { responseDisconnectSignal } from './http/response-disconnect-signal.ts';
import { UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS } from './http/ingress-budget.ts';
import { sendRestJsonError } from './http-errors.ts';

/**
 * The finite budgets one inbound upload request runs under (#4441): a 600-second
 * aggregate armed when the request is admitted at the callback, and a 120-second
 * body-inactivity ceiling admitted at the same moment and renewed only by body
 * progress. The header phase keeps its own server-level ceiling (ingress-budget.ts).
 * Progress never renews the aggregate, and client disconnect shares this owner
 * through the existing response-disconnect signal.
 */
const TRANSFER_PHASE_TIMEOUT_REASON = 'transfer_phase_timeout';
const TRANSFER_INGRESS_AGGREGATE_REASON = 'transfer_ingress_deadline_exceeded';

export type UploadTransferIngress = {
  /** Aborts on aggregate expiry or client disconnect while the request is unfinished. */
  readonly signal: AbortSignal;
  /**
   * Renews only the inactivity ceiling; never the aggregate. Progress that arrives after
   * a deadline has passed expires the request instead of renewing it.
   */
  onAcceptedBodyBytes(bytes: number): void;
  /**
   * Stops only the inactivity ceiling once the request body is complete, and keeps the
   * connection open for the answer. Post-body work (hash, extraction, registration) then
   * observes just the aggregate. It clears a deadline, so it commits through `commit` and
   * throws the typed expiry when the inactivity deadline already passed.
   */
  bodyComplete(): void;
  /**
   * The only way to commit work that becomes externally visible: an answer, a ticket, a
   * registration, an offset, or a cleared deadline. It first compares the recorded
   * monotonic deadlines, so a deadline that passed before its timer callback ran expires
   * the request through the same path as the timer and the work is refused with the typed
   * expiry. `commit(() => undefined)` is the same gate for a cancellation point.
   */
  commit<T>(work: () => T): T;
  /**
   * Releases the request. With the body read, both timers stop at once. With the body
   * unread, the connection closes after the answer flushes, and both timers keep bounding
   * it until the socket closes. Safe to call more than once; does not abort.
   */
  dispose(): void;
};

/**
 * Admits one upload request's transfer budgets. Armed at the request callback, not
 * lazily on the first byte, so a stalled body is bounded from admission. Each deadline
 * is also recorded on the monotonic clock, so work that crosses it before the timer
 * callback runs cannot commit or publish success.
 *
 * Expiry aborts owned work with a typed reason and ends the HTTP exchange whatever the
 * request stream's state: it answers with the typed error when no answer has started,
 * and it closes a connection whose body is unread once this request's answer flushes.
 * A request whose answer is queued behind an earlier pipelined answer never closes the
 * socket under that earlier answer. The handler keeps owning its in-flight filesystem
 * work through cleanup or rollback.
 *
 * The ingress also owns the early-answer rule: every answer sent before the body is
 * consumed carries `Connection: close`, and that connection ends after the answer
 * flushes, under these timers. A keep-alive connection never drains an unread body
 * outside the ingress budget. The close lingers (RFC 9112 §9.6): the server half-closes
 * after the answer and discards the rest of the body until the body ends, the client
 * closes, or a timer fires. A full close with unread bytes resets the connection, and
 * a client that is still sending then loses the answer.
 */
export function beginUploadTransferIngress(params: {
  req: IncomingMessage;
  res: ServerResponse;
}): UploadTransferIngress {
  const { req, res } = params;
  // Until the body is complete, any answer is an early answer.
  res.setHeader('connection', 'close');
  const releaseLinger = holdLingeringClose(req);
  const expiry = new AbortController();
  const signal = AbortSignal.any([expiry.signal, responseDisconnectSignal(req, res)]);
  const admittedAt = performance.now();
  const aggregateDeadline = admittedAt + UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS;
  let inactivityDeadline: number | undefined;
  const aggregateTimer: ReturnType<typeof setTimeout> = setTimeout(
    () => fail(aggregateExpiry()),
    UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS,
  );
  aggregateTimer.unref();
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let released = false;

  const stopInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
    inactivityDeadline = undefined;
  };

  const stopTimers = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(aggregateTimer);
    stopInactivity();
  };

  const overdueExpiry = (): AppError | undefined => {
    const now = performance.now();
    if (now >= aggregateDeadline) return aggregateExpiry();
    if (inactivityDeadline !== undefined && now >= inactivityDeadline) return inactivityExpiry();
    return undefined;
  };

  const dispose = () => {
    if (disposed || released) return;
    // An overdue deadline is never cleared by a release: it expires the request instead.
    const overdue = overdueExpiry();
    if (overdue) {
      fail(overdue);
      return;
    }
    released = true;
    // A finished exchange may already have detached its socket.
    const socket = req.socket as IncomingMessage['socket'] | null;
    if (req.complete || !socket || socket.destroyed) {
      releaseLinger();
      stopTimers();
      return;
    }
    // The body is unread (an early answer, or a pipeline stopped by a byte cap, a length
    // mismatch or an expired ticket): after the answer flushes, the same lingering close
    // as an expiry discards the rest within its grace. The timers bound the wait until then.
    socket.once('close', stopTimers);
    const closeConnection = () => lingerThenClose(req);
    if (res.writableFinished) closeConnection();
    else res.once('finish', closeConnection);
  };

  const fail = (error: AppError) => {
    if (disposed) return;
    stopTimers();
    expiry.abort(error);
    endExchange(req, res, error);
  };

  const armInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityDeadline = performance.now() + TRANSFER_BODY_INACTIVITY_TIMEOUT_MS;
    inactivityTimer = setTimeout(
      () => fail(inactivityExpiry()),
      TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
    );
    inactivityTimer.unref();
  };

  const commit = <T>(work: () => T): T => {
    if (!disposed) {
      const overdue = overdueExpiry();
      if (overdue) fail(overdue);
    }
    throwIfIngressAborted(signal);
    return work();
  };

  armInactivity();

  return {
    signal,
    onAcceptedBodyBytes(bytes: number) {
      if (disposed || bytes <= 0) return;
      const overdue = overdueExpiry();
      if (overdue) {
        fail(overdue);
        return;
      }
      armInactivity();
    },
    bodyComplete() {
      commit(() => {
        releaseLinger();
        if (!res.headersSent) res.removeHeader('connection');
        stopInactivity();
      });
    },
    commit,
    dispose,
  };
}

function aggregateExpiry(): AppError {
  return new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
    reason: TRANSFER_INGRESS_AGGREGATE_REASON,
    transferPhase: 'request-body',
    timeoutMs: UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS,
  });
}

function inactivityExpiry(): AppError {
  return new AppError('COMMAND_FAILED', 'Upload body stalled', {
    reason: TRANSFER_PHASE_TIMEOUT_REASON,
    transferPhase: 'request-body',
    timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  });
}

/**
 * Ends one expired exchange in response order. No answer started: answer with the typed
 * error now; Node writes it after any earlier pipelined answer. Body unread: once this
 * request's own answer flushes, hand the socket to its close owner's lingering close and
 * discard the rest of the body, bounded by a short grace. A queued request therefore never
 * closes the socket under an earlier answer, and a full close never resets a client that
 * is still sending before it reads the answers.
 */
function endExchange(req: IncomingMessage, res: ServerResponse, error: AppError): void {
  if (!res.headersSent) {
    res.setHeader('connection', 'close');
    sendRestJsonError(res, normalizeError(error));
  }
  if (req.complete) return;
  const closeConnection = () => lingerThenClose(req);
  if (res.writableFinished) closeConnection();
  else res.once('finish', closeConnection);
}

/** How long a connection may linger after its answer to discard an unread body. */
const EXPIRED_BODY_LINGER_GRACE_MS = 5_000;

function lingerThenClose(req: IncomingMessage): void {
  const socket = req.socket as IncomingMessage['socket'] | null;
  if (!socket || socket.destroyed) return;
  const grace = setTimeout(() => socket.destroy(), EXPIRED_BODY_LINGER_GRACE_MS);
  grace.unref();
  socket.once('close', () => clearTimeout(grace));
  // Discard the rest of the expired body; the close owner half-closes until it ends.
  req.resume();
  socket.destroySoon();
}

/**
 * The one close owner of a socket. Node calls `destroySoon` after a `Connection: close`
 * answer. While any request on the socket still has an unread body, the owner only
 * half-closes, and the full close waits until the last such body ends or its request
 * closes. Requests register their interest; none of them replaces the owner.
 */
type SocketCloseOwner = {
  readonly unread: Set<IncomingMessage>;
  lingering: boolean;
  readonly closeNow: () => void;
};

const socketCloseOwners = new WeakMap<Socket, SocketCloseOwner>();

function socketCloseOwner(socket: Socket): SocketCloseOwner {
  const existing = socketCloseOwners.get(socket);
  if (existing) return existing;
  const destroySoon = socket.destroySoon;
  const owner: SocketCloseOwner = {
    unread: new Set(),
    lingering: false,
    closeNow: () => destroySoon.call(socket),
  };
  socket.destroySoon = function lingeringClose(this: Socket): void {
    if (owner.unread.size === 0) {
      owner.closeNow();
      return;
    }
    if (this.writable) this.end();
    owner.lingering = true;
  };
  socketCloseOwners.set(socket, owner);
  return owner;
}

/**
 * Registers this request's unread body with its socket's close owner. Returns the release
 * for the moment the body no longer needs a lingering close; release is idempotent.
 */
function holdLingeringClose(req: IncomingMessage): () => void {
  const socket = req.socket as IncomingMessage['socket'] | null;
  if (!socket || req.complete) return () => {};
  const owner = socketCloseOwner(socket);
  owner.unread.add(req);
  const release = () => {
    if (!owner.unread.delete(req)) return;
    if (owner.lingering && owner.unread.size === 0) owner.closeNow();
  };
  req.once('end', release);
  req.once('close', release);
  return release;
}

/**
 * Resolves which failure a joined upload pipeline reports, by the owned signal state and
 * never by error text. When the ingress signal is aborted, it owns every unclassified
 * failure, so its typed reason is reported. A failure that is already a typed AppError
 * (an earlier classification such as a byte limit or ticket expiry) is kept unchanged.
 */
export function resolveIngressFailure(signal: AbortSignal | undefined, failure: unknown): unknown {
  if (!signal?.aborted || failure instanceof AppError) return failure;
  try {
    throwIfIngressAborted(signal);
  } catch (error) {
    return error;
  }
  return failure;
}

/** Throws the ingress owner's typed abort reason when its signal already fired. */
export function throwIfIngressAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new AppError('COMMAND_FAILED', 'Upload canceled', { reason: 'upload_canceled' });
}
