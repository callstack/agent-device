import { AppError } from '../kernel/errors.ts';

const canceledRequestIds = new Set<string>();
const requestAbortControllers = new Map<string, AbortController>();
const REQUEST_CANCELED_REASON = 'request_canceled';
const REQUEST_CANCELED_MESSAGE = 'request canceled';

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
      .replace(/[^a-zA-Z0-9_-]/g, '_')
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

export function registerRequestAbort(requestId: string | undefined): void {
  if (!requestId) return;
  evictOldestEntries(requestAbortControllers);
  const controller = new AbortController();
  requestAbortControllers.set(requestId, controller);
  if (canceledRequestIds.has(requestId)) {
    controller.abort();
  }
}

export function markRequestCanceled(requestId: string | undefined): void {
  if (!requestId) return;
  evictOldestSetEntries(canceledRequestIds);
  canceledRequestIds.add(requestId);
  requestAbortControllers.get(requestId)?.abort();
}

export function clearRequestCanceled(requestId: string | undefined): void {
  if (!requestId) return;
  canceledRequestIds.delete(requestId);
  requestAbortControllers.delete(requestId);
}

export function isRequestCanceled(requestId: string | undefined): boolean {
  if (!requestId) return false;
  return canceledRequestIds.has(requestId);
}

export function getRequestSignal(requestId: string | undefined): AbortSignal | undefined {
  if (!requestId) return undefined;
  return requestAbortControllers.get(requestId)?.signal;
}

export function createRequestCanceledError(): AppError {
  return new AppError('COMMAND_FAILED', REQUEST_CANCELED_MESSAGE, {
    reason: REQUEST_CANCELED_REASON,
  });
}

export function throwIfRequestCanceled(requestId: string | undefined): void {
  if (isRequestCanceled(requestId)) {
    throw createRequestCanceledError();
  }
}

export function isRequestCanceledError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMMAND_FAILED') return false;
  if (error.details?.reason === REQUEST_CANCELED_REASON) return true;
  return error.message === REQUEST_CANCELED_MESSAGE;
}
