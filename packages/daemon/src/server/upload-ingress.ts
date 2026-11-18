import type { IncomingMessage, ServerResponse } from 'node:http';
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
const UPLOAD_TRANSFER_AGGREGATE_TIMEOUT_MS = 600_000;
const TRANSFER_PHASE_TIMEOUT_REASON = 'transfer_phase_timeout';
const TRANSFER_INGRESS_AGGREGATE_REASON = 'transfer_ingress_deadline_exceeded';

export type UploadTransferIngress = {
  /** Aborts on aggregate expiry or client disconnect while the request is unfinished. */
  readonly signal: AbortSignal;
  /** Renews only the inactivity ceiling; never the aggregate. */
  onAcceptedBodyBytes(bytes: number): void;
  /**
   * Stops only the inactivity ceiling once the request body is complete. Post-body
   * work (hash, extraction, registration) then observes just the aggregate. Safe to
   * call more than once; does not abort.
   */
  bodyComplete(): void;
  /** Stops both timers. Safe to call more than once; does not abort. */
  dispose(): void;
};

/**
 * Admits one upload request's transfer budgets. Armed at the request callback, not
 * lazily on the first byte, so a stalled body is bounded from admission. Expiry
 * destroys the request stream and aborts owned work with a typed reason.
 */
export function beginUploadTransferIngress(params: {
  req: IncomingMessage;
  res: ServerResponse;
}): UploadTransferIngress {
  const { req, res } = params;
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

  const stopInactivity = () => {
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    inactivityTimer = undefined;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(aggregateTimer);
    stopInactivity();
  };

  const fail = (error: AppError) => {
    if (disposed) return;
    dispose();
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
      if (!disposed) stopInactivity();
    },
    dispose,
  };
}

/**
 * Resolves which failure a joined upload pipeline reports. When the ingress signal owns
 * the abort, Node's pipeline rejects with a generic AbortError, so the owner's typed
 * reason is restored here. An earlier classified failure (any non-abort error, including
 * a different typed reason) is returned unchanged.
 */
export function resolveIngressFailure(signal: AbortSignal | undefined, error: unknown): unknown {
  if (!signal?.aborted) return error;
  const reason = signal.reason;
  if (error === reason) return error;
  if (isGenericAbortError(error) && reason instanceof Error) return reason;
  return error;
}

/** Throws the ingress owner's typed abort reason when its signal already fired. */
export function throwIfIngressAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new AppError('COMMAND_FAILED', 'Upload canceled', { reason: 'upload_canceled' });
}

function isGenericAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return name === 'AbortError' || code === 'ABORT_ERR';
}
