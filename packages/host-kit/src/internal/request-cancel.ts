import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';

const canceledRequestIds = new Set<string>();
const requestAbortControllers = new Map<string, AbortController>();

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
  if (requestAbortControllers.has(requestId)) {
    throw new AppError('INVALID_ARGS', `Request ID is already in flight: ${requestId}`, {
      requestId,
      reason: 'duplicate_request_id',
    });
  }
  evictOldestEntries(requestAbortControllers);
  const controller = new AbortController();
  requestAbortControllers.set(requestId, controller);
  if (canceledRequestIds.has(requestId)) {
    controller.abort();
  }
  return { requestId, controller };
}

export function markRequestCanceled(requestId: string | undefined): void {
  if (!requestId) return;
  evictOldestSetEntries(canceledRequestIds);
  canceledRequestIds.add(requestId);
  // Abort WITH the typed error as the reason: every `signal.throwIfAborted()`,
  // fetch, and `throw signal.reason` downstream then surfaces the canceled
  // request as such, instead of a bare DOMException that normalizes to UNKNOWN.
  // No call site has to remember the factory — the signal carries it.
  requestAbortControllers.get(requestId)?.abort(createRequestCanceledError());
}

export function clearRequestCanceled(
  requestId: string | undefined,
  registration?: RequestAbortRegistration,
): void {
  if (!requestId) return;
  if (
    registration &&
    (registration.requestId !== requestId ||
      requestAbortControllers.get(requestId) !== registration.controller)
  ) {
    return;
  }
  canceledRequestIds.delete(requestId);
  requestAbortControllers.delete(requestId);
}

export function clearRequestAbortRegistration(
  registration: RequestAbortRegistration | undefined,
): void {
  if (!registration) return;
  clearRequestCanceled(registration.requestId, registration);
}

export function isRequestCanceled(requestId: string | undefined): boolean {
  if (!requestId) return false;
  return canceledRequestIds.has(requestId);
}

export function getRequestSignal(requestId: string | undefined): AbortSignal | undefined {
  if (!requestId) return undefined;
  return requestAbortControllers.get(requestId)?.signal;
}

export function throwIfRequestCanceled(requestId: string | undefined): void {
  if (isRequestCanceled(requestId)) {
    throw createRequestCanceledError();
  }
}
