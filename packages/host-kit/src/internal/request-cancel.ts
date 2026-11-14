import {
  AppError,
  createRequestCanceledError,
  createRequestDeadlineError,
  isRequestCanceledDetails,
  isRequestCanceledError,
  isRequestDeadlineDetails,
  REQUEST_DEADLINE_REASON,
} from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { runtimeSlot } from '../runtime-slots.ts';

type RequestCancelState = {
  canceledRequestIds: Set<string>;
  requestAbortControllers: Map<string, RequestAbortController>;
};

type RequestAbortController = AbortController & {
  executionDeadlineMs?: number;
  /**
   * The daemon's own result deadline, which the transport that admitted the request set ahead of
   * the client's: the end of the client envelope less the daemon's result margin. An attempt
   * registered under a parent inherits the parent's, because it runs inside the parent's envelope.
   */
  resultDeadlineMs?: number;
  /**
   * Whether the admitted request only reads: no step of it dispatches an action, so a resend loop
   * inside it may spend its deadline. An attempt registered under a parent inherits the parent's.
   */
  readOnly?: boolean;
};

const REQUEST_CANCEL_SLOT = Symbol('requestCancel');
const requestCancelState = (): RequestCancelState =>
  runtimeSlot(
    REQUEST_CANCEL_SLOT,
    (): RequestCancelState => ({
      canceledRequestIds: new Set<string>(),
      requestAbortControllers: new Map<string, RequestAbortController>(),
    }),
    (state) => {
      for (const controller of state.requestAbortControllers.values()) controller.abort();
    },
  );
const canceledRequestIds = () => requestCancelState().canceledRequestIds;
const requestAbortControllers = () => requestCancelState().requestAbortControllers;

export type RequestAbortRegistration = {
  requestId: string;
  controller: AbortController;
};

export function resolveRequestTrackingId(
  requestId: string | undefined,
  fallbackSeed?: unknown,
): string {
  if (typeof requestId === 'string' && requestId.length > 0) return requestId;
  const rawSeed =
    typeof fallbackSeed === 'string'
      ? fallbackSeed
      : typeof fallbackSeed === 'number' && Number.isFinite(fallbackSeed)
        ? String(fallbackSeed)
        : 'generated';
  const normalizedSeed =
    rawSeed
      .trim()
      .replaceAll(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 32) || 'generated';
  const nonce = Math.random().toString(36).slice(2, 10);
  return `req:${normalizedSeed}:${process.pid}:${Date.now()}:${nonce}`;
}

const COLLECTION_HIGH_WATERMARK = 50_000;
const COLLECTION_EVICT_COUNT = 10_000;

function evictOldestSetEntries<V>(set: Set<V>): void {
  if (set.size <= COLLECTION_HIGH_WATERMARK) return;
  let removed = 0;
  for (const value of set) {
    if (removed >= COLLECTION_EVICT_COUNT) break;
    set.delete(value);
    removed++;
  }
}

export function registerRequestAbort(
  requestId: string | undefined,
  parentRequestId?: string,
  admission?: Readonly<{ resultDeadlineMs?: number; readOnly?: boolean }>,
): RequestAbortRegistration | undefined {
  if (!requestId) return undefined;
  if (requestAbortControllers().has(requestId)) {
    throw new AppError('INVALID_ARGS', `Request ID is already in flight: ${requestId}`, {
      requestId,
      reason: 'duplicate_request_id',
    });
  }
  const controller: RequestAbortController = new AbortController();
  const parent = parentRequestId ? requestAbortControllers().get(parentRequestId) : undefined;
  controller.executionDeadlineMs = parent?.executionDeadlineMs;
  controller.resultDeadlineMs = parentRequestId
    ? parent?.resultDeadlineMs
    : admission?.resultDeadlineMs;
  controller.readOnly = parentRequestId ? parent?.readOnly : admission?.readOnly;
  requestAbortControllers().set(requestId, controller);
  if (canceledRequestIds().has(requestId)) {
    controller.abort(createRequestCanceledError());
  }
  return { requestId, controller };
}

export function markRequestCanceled(requestId: string | undefined): void {
  if (!requestId) return;
  evictOldestSetEntries(canceledRequestIds());
  canceledRequestIds().add(requestId);
  // Abort WITH the typed error as the reason: every `signal.throwIfAborted()`,
  // fetch, and `throw signal.reason` downstream then surfaces the canceled
  // request as such, instead of a bare DOMException that normalizes to UNKNOWN.
  // No call site has to remember the factory — the signal carries it.
  requestAbortControllers().get(requestId)?.abort(createRequestCanceledError());
}

/** Aborts every request this runtime has in flight, as a canceled request. */
export function cancelAllRequests(): void {
  for (const requestId of requestAbortControllers().keys()) markRequestCanceled(requestId);
}

export function clearRequestCanceled(
  requestId: string | undefined,
  registration?: RequestAbortRegistration,
): void {
  if (!requestId) return;
  if (
    registration &&
    (registration.requestId !== requestId ||
      requestAbortControllers().get(requestId) !== registration.controller)
  ) {
    return;
  }
  canceledRequestIds().delete(requestId);
  requestAbortControllers().delete(requestId);
}

export function clearRequestAbortRegistration(
  registration: RequestAbortRegistration | undefined,
): void {
  if (!registration) return;
  clearRequestCanceled(registration.requestId, registration);
}

export function isRequestCanceled(requestId: string | undefined): boolean {
  if (!requestId) return false;
  return canceledRequestIds().has(requestId) || getRequestSignal(requestId)?.aborted === true;
}

export function getRequestSignal(requestId: string | undefined): AbortSignal | undefined {
  if (!requestId) return undefined;
  return requestAbortControllers().get(requestId)?.signal;
}

/** The original bounded composite cutoff, inherited by nested test attempts. */
export function getRequestExecutionDeadlineMs(requestId: string | undefined): number | undefined {
  return requestId ? requestAbortControllers().get(requestId)?.executionDeadlineMs : undefined;
}

/** The daemon's result deadline the admitting transport set for the request, if it set one. */
export function getRequestResultDeadlineMs(requestId: string | undefined): number | undefined {
  return requestId ? requestAbortControllers().get(requestId)?.resultDeadlineMs : undefined;
}

/** The earlier of the request's execution and result deadlines, if it runs under either. */
export function getRequestDeadlineMs(requestId: string | undefined): number | undefined {
  const deadlines = [
    getRequestExecutionDeadlineMs(requestId),
    getRequestResultDeadlineMs(requestId),
  ].filter((deadlineMs) => deadlineMs !== undefined);
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}

/**
 * The deadline a resend loop may spend, which is the request's deadline only when the request is
 * read-only. A read inside an action leaves that budget to the action dispatched after it.
 */
export function getRequestReadOnlyDeadlineMs(requestId: string | undefined): number | undefined {
  if (!requestId || requestAbortControllers().get(requestId)?.readOnly !== true) return undefined;
  return getRequestDeadlineMs(requestId);
}

export function throwIfRequestCanceled(requestId: string | undefined): void {
  getRequestSignal(requestId)?.throwIfAborted();
  if (isRequestCanceled(requestId)) {
    throw createRequestCanceledError();
  }
}

function deadlineFailure(error: unknown, timeoutMs: number, requestId: string): AppError {
  const { hint, ...prior } = error instanceof AppError ? (error.details ?? {}) : {};
  return createRequestDeadlineError(
    {
      ...prior,
      ...(typeof prior.reason === 'string' && !isRequestDeadlineDetails(prior)
        ? { causeReason: prior.reason }
        : {}),
      timeoutMs,
      requestId,
      ...(hint === undefined || isRequestCanceledError(error) ? {} : { hint }),
    },
    error,
  );
}

function projectDeadlineResponse(result: DaemonResponse, timeoutMs: number): DaemonResponse {
  if (result.ok) return result;
  const priorReason = result.error.details?.reason;
  const deadline = createRequestDeadlineError();
  return {
    ...result,
    error: {
      ...result.error,
      ...(isRequestCanceledDetails(result.error.details)
        ? { message: deadline.message, hint: String(deadline.details?.hint) }
        : {}),
      details: {
        ...result.error.details,
        ...(typeof priorReason === 'string' && !isRequestDeadlineDetails(result.error.details)
          ? { causeReason: priorReason }
          : {}),
        reason: REQUEST_DEADLINE_REASON,
        timeoutMs,
      },
    },
  };
}

/** Keeps a daemon deadline on the request's existing cancellation signal until its work settles. */
export async function withRequestDeadline(
  requestId: string,
  timeoutMs: number,
  task: () => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  const ownedRegistration = requestAbortControllers().has(requestId)
    ? undefined
    : registerRequestAbort(requestId);
  const controller = requestAbortControllers().get(requestId)!;
  const deadlineMs = Math.min(controller.executionDeadlineMs ?? Infinity, Date.now() + timeoutMs);
  controller.executionDeadlineMs = deadlineMs;
  let deadlineCanceled = false;
  const expire = () => {
    if (controller.signal.aborted) return;
    deadlineCanceled = true;
    controller.abort(createRequestCanceledError({ timeoutMs, requestId }));
  };
  const timer = setTimeout(expire, Math.max(0, deadlineMs - Date.now()));
  try {
    controller.signal.throwIfAborted();
    const result = await task();
    if (Date.now() >= deadlineMs) expire();
    if (deadlineCanceled) return projectDeadlineResponse(result, timeoutMs);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (Date.now() >= deadlineMs) expire();
    if (deadlineCanceled) throw deadlineFailure(error, timeoutMs, requestId);
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    clearRequestAbortRegistration(ownedRegistration);
  }
}
