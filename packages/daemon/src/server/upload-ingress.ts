import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import { TRANSFER_BODY_INACTIVITY_TIMEOUT_MS } from '@agent-device/host-kit/transport';
import { responseDisconnectSignal } from './http/response-disconnect-signal.ts';

/**
 * The finite budgets one inbound upload request runs under (#4441): a 600-second
 * aggregate armed when the request is admitted at the callback, and a 120-second
 * body-inactivity ceiling admitted at the same moment and renewed only by body
 * progress. The header phase keeps its own server-level ceiling (headersTimeout).
 * Progress never renews the aggregate, and client disconnect shares this owner
 * through the existing response-disconnect signal.
 */
export const UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS = 600_000;
const TRANSFER_PHASE_TIMEOUT_REASON = 'transfer_phase_timeout';
const TRANSFER_INGRESS_AGGREGATE_REASON = 'transfer_ingress_deadline_exceeded';

export type UploadTransferIngress = {
  /** Aborts on aggregate expiry or client disconnect while the request is unfinished. */
  readonly signal: AbortSignal;
  /** Renews only the inactivity ceiling; never the aggregate. */
  onAcceptedBodyBytes(bytes: number): void;
  /**
   * Stops only the inactivity ceiling once the request body is complete, and keeps the
   * connection open for the answer. Post-body work (hash, extraction, registration) then
   * observes just the aggregate. Safe to call more than once; does not abort.
   */
  bodyComplete(): void;
  /**
   * Releases the request. With the body read, both timers stop at once. With the body
   * unread, the connection closes after the answer flushes, and both timers keep bounding
   * it until the socket closes. Safe to call more than once; does not abort.
   */
  dispose(): void;
};

/**
 * Admits one upload request's transfer budgets. Armed at the request callback, not
 * lazily on the first byte, so a stalled body is bounded from admission. Expiry
 * destroys the request stream and aborts owned work with a typed reason.
 *
 * The ingress also owns the early-answer rule: every answer sent before the body is
 * consumed carries `Connection: close`, and that connection ends after the answer
 * flushes, under these timers. A failure while the body is being consumed destroys the
 * request instead. A keep-alive connection never drains an unread body
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
  const aggregateTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    fail(
      new AppError('COMMAND_FAILED', 'Upload transfer deadline exceeded', {
        reason: TRANSFER_INGRESS_AGGREGATE_REASON,
        transferPhase: 'request-body',
        timeoutMs: UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS,
      }),
    );
  }, UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS);
  aggregateTimer.unref();
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let released = false;

  const stopInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };

  const stopTimers = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(aggregateTimer);
    stopInactivity();
  };

  const dispose = () => {
    if (disposed || released) return;
    released = true;
    // A finished exchange may already have detached its socket.
    const socket = req.socket as IncomingMessage['socket'] | null;
    if (req.complete || !socket || socket.destroyed) {
      releaseLinger();
      stopTimers();
      return;
    }
    socket.once('close', stopTimers);
    const closeConnection = () => {
      if (!socket.destroyed) socket.destroySoon();
    };
    if (res.writableFinished) closeConnection();
    else res.once('finish', closeConnection);
  };

  const fail = (error: AppError) => {
    if (disposed) return;
    stopTimers();
    expiry.abort(error);
    req.destroy(error);
  };

  const armInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      fail(
        new AppError('COMMAND_FAILED', 'Upload body stalled', {
          reason: TRANSFER_PHASE_TIMEOUT_REASON,
          transferPhase: 'request-body',
          timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
        }),
      );
    }, TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
    inactivityTimer.unref();
  };

  armInactivity();

  return {
    signal,
    onAcceptedBodyBytes(bytes: number) {
      if (!disposed && bytes > 0) armInactivity();
    },
    bodyComplete() {
      releaseLinger();
      if (!res.headersSent) res.removeHeader('connection');
      if (!disposed) stopInactivity();
    },
    dispose,
  };
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
