import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { runtimeSlot } from '../runtime-slots.ts';

type RequestCancelState = {
  canceledRequestIds: Set<string>;
  requestAbortControllers: Map<string, AbortController>;
};

const REQUEST_CANCEL_SLOT = Symbol('requestCancel');
const requestCancelState = (): RequestCancelState =>
  runtimeSlot(
    REQUEST_CANCEL_SLOT,
    (): RequestCancelState => ({
      canceledRequestIds: new Set<string>(),
      requestAbortControllers: new Map<string, AbortController>(),
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

function evictOldestEntries<K, V>(map: Map<K, V>): void {
  if (map.size <= COLLECTION_HIGH_WATERMARK) return;
  let removed = 0;
  for (const key of map.keys()) {
    if (removed >= COLLECTION_EVICT_COUNT) break;
    map.delete(key);
    removed++;
  }
}

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
): RequestAbortRegistration | undefined {
  if (!requestId) return undefined;
  if (requestAbortControllers().has(requestId)) {
    throw new AppError('INVALID_ARGS', `Request ID is already in flight: ${requestId}`, {
      requestId,
      reason: 'duplicate_request_id',
    });
  }
  evictOldestEntries(requestAbortControllers());
  const controller = new AbortController();
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

export function throwIfRequestCanceled(requestId: string | undefined): void {
  getRequestSignal(requestId)?.throwIfAborted();
  if (isRequestCanceled(requestId)) {
    throw createRequestCanceledError();
  }
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
  const deadlineMs = Date.now() + timeoutMs;
  const deadlineError = new AppError('COMMAND_FAILED', 'Daemon request deadline exceeded', {
    reason: 'daemon_request_timeout',
    timeoutMs,
    requestId,
  });
  const expire = () => controller.abort(deadlineError);
  const timer = setTimeout(expire, timeoutMs);
  try {
    controller.signal.throwIfAborted();
    const result = await task();
    if (Date.now() >= deadlineMs) expire();
    if (controller.signal.reason === deadlineError) {
      return result.ok
        ? result
        : {
            ...result,
            error: {
              ...result.error,
              details: {
                ...result.error.details,
                ...(typeof result.error.details?.reason === 'string' &&
                result.error.details.reason !== 'daemon_request_timeout'
                  ? { causeReason: result.error.details.reason }
                  : {}),
                reason: 'daemon_request_timeout',
                timeoutMs,
              },
            },
          };
    }
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (Date.now() >= deadlineMs) expire();
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
    clearRequestAbortRegistration(ownedRegistration);
  }
}
