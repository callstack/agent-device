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

type RequestExecutionDeadline = Readonly<{ deadlineMs: number; expire(): void }>;

type RequestAbortController = AbortController & {
  executionDeadlines?: Set<RequestExecutionDeadline>;
  parent?: RequestAbortController;
  deadlineRegistration?: RequestAbortRegistration;
  executionDeadlineCancellation?: Readonly<{ timeoutMs: number; requestId: string }>;
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
  controller.parent = parent;
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

/** The effective execution cutoff, including live parent deadlines. */
export function getRequestExecutionDeadlineMs(requestId: string | undefined): number | undefined {
  const controller = requestId ? requestAbortControllers().get(requestId) : undefined;
  return controller ? effectiveExecutionDeadline(controller)?.deadlineMs : undefined;
}

function effectiveExecutionDeadline(
  controller: RequestAbortController,
): RequestExecutionDeadline | undefined {
  let earliest = controller.parent ? effectiveExecutionDeadline(controller.parent) : undefined;
  for (const own of controller.executionDeadlines ?? []) {
    if (!earliest || own.deadlineMs < earliest.deadlineMs) earliest = own;
  }
  return earliest;
}

/** Enforces the live execution cutoff through its existing owner, preserving earlier cancellation. */
export function throwIfRequestExecutionDeadlineExceeded(requestId: string | undefined): void {
  const controller = requestId ? requestAbortControllers().get(requestId) : undefined;
  if (!controller) return;
  enforceExecutionDeadline(controller);
  controller.signal.throwIfAborted();
}

function inheritRequestCancellation(controller: RequestAbortController): boolean {
  for (
    let current: RequestAbortController | undefined = controller;
    current;
    current = current.parent
  ) {
    if (!current.signal.aborted) continue;
    if (!controller.signal.aborted) {
      controller.executionDeadlineCancellation = current.executionDeadlineCancellation;
      controller.abort(current.signal.reason);
    }
    return true;
  }
  return false;
}

function enforceExecutionDeadline(controller: RequestAbortController): void {
  if (inheritRequestCancellation(controller)) return;
  const deadline = effectiveExecutionDeadline(controller);
  if (deadline && Date.now() >= deadline.deadlineMs) deadline.expire();
  inheritRequestCancellation(controller);
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

/**
 * The signal a request-scoped child phase (source materialization) must observe: the request's
 * shared cancellation composed with the earliest registered execution/result deadline less the
 * reserve the rest of the route still needs (#4441, decisions 6827686874/6856998913). The phases
 * share one runtime cancellation, so an operator's cancel or an earlier cutoff aborts this too;
 * the timeout part is the remaining deadline budget, never an independent maximum. With no
 * deadline armed, the request's own signal is returned unchanged and the caller's standalone
 * aggregate stays the only cap.
 */
export function getRequestBudgetSignal(
  requestId: string | undefined,
  reserveMs: number,
): AbortSignal | undefined {
  const requestSignal = getRequestSignal(requestId);
  const deadlineMs = getRequestDeadlineMs(requestId);
  if (deadlineMs === undefined) return requestSignal;
  const remainingMs = Math.max(0, deadlineMs - Date.now() - reserveMs);
  const budgetSignal = AbortSignal.timeout(remainingMs);
  return requestSignal ? AbortSignal.any([requestSignal, budgetSignal]) : budgetSignal;
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
  if (ownedRegistration) controller.deadlineRegistration = ownedRegistration;
  const startedAtMs = Date.now();
  const deadlineMs = Math.min(
    startedAtMs + timeoutMs,
    controller.resultDeadlineMs ?? Number.POSITIVE_INFINITY,
  );
  const expire = () => {
    if (controller.signal.aborted) return;
    const cancellation = { timeoutMs: Math.max(0, deadlineMs - startedAtMs), requestId };
    controller.executionDeadlineCancellation = cancellation;
    controller.abort(createRequestCanceledError(cancellation));
  };
  const ownedDeadline = { deadlineMs, expire };
  const deadlines = (controller.executionDeadlines ??= new Set());
  deadlines.add(ownedDeadline);
  const arm = (): ReturnType<typeof setTimeout> =>
    setTimeout(
      onTimer,
      Math.max(0, (effectiveExecutionDeadline(controller)?.deadlineMs ?? deadlineMs) - Date.now()),
    );
  const onTimer = () => {
    enforceExecutionDeadline(controller);
    if (!controller.signal.aborted) timer = arm();
  };
  let timer = arm();
  try {
    enforceExecutionDeadline(controller);
    controller.signal.throwIfAborted();
    const result = await task();
    enforceExecutionDeadline(controller);
    const cancellation = controller.executionDeadlineCancellation;
    if (cancellation) return projectDeadlineResponse(result, cancellation.timeoutMs);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    enforceExecutionDeadline(controller);
    const cancellation = controller.executionDeadlineCancellation;
    if (cancellation) throw deadlineFailure(error, cancellation.timeoutMs, cancellation.requestId);
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    deadlines.delete(ownedDeadline);
    if (deadlines.size === 0) {
      clearRequestAbortRegistration(controller.deadlineRegistration);
      controller.deadlineRegistration = undefined;
    }
  }
}
