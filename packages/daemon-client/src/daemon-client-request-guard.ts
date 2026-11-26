import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';

/**
 * The requester-side half of a per-call `AbortSignal` (#3178). The transport half
 * (`daemon-client-transport.ts`) closes the
 * request's connection (which is what makes the daemon mark the request canceled); this half
 * answers for the cases a transport cannot observe:
 *
 * - a signal already aborted before anything is sent — nothing may leave the process, so the refusal
 *   carries `details.dispatched: 'no'`;
 * - an abort during a phase with no connection to close, or a custom transport that ignores the
 *   signal — the caller's promise still settles, with `details.dispatched: 'unknown'` because the
 *   request may already have been written.
 *
 * Both reject with the typed canceled-request error (`details.reason: 'request_canceled'`) whatever
 * reason the caller aborted with, so every layer dispatches on the same reason and never on the
 * caller's arbitrary abort reason or on error text. An abort is never a timeout: nothing here reads
 * or extends a request deadline, and no timeout path may produce this rejection.
 */

/**
 * The typed canceled-request error for a caller's own abort. The reason the caller aborted with
 * survives unchanged as the cause — `AbortController.abort()` accepts any value — while the
 * rejection itself dispatches on `reason: 'request_canceled'` with the delivery evidence the
 * aborting layer can prove. A built-in transport rejects every abort through this, so a caller's
 * arbitrary abort reason never escapes as the outcome of a daemon request.
 */
export function abortedRequestError(
  signal: AbortSignal,
  dispatched: 'no' | 'unknown',
  requestId?: string,
): AppError {
  return createRequestCanceledError({ requestId, dispatched }, signal.reason);
}

/**
 * Refuses a send attempt that starts while the caller's signal is already aborted: nothing may leave
 * the process, so this never touches a connection and the refusal carries `details.dispatched: 'no'`.
 */
export function refuseAbortedRequest(signal: AbortSignal | undefined, requestId?: string): void {
  if (!signal?.aborted) return;
  throw abortedRequestError(signal, 'no', requestId);
}

type RequestGuard = {
  /** Refuses an already-aborted call before anything is sent. No-op without a signal. */
  refuseIfAborted(): void;
  /** Settles `send`'s outcome against the signal, winning with the typed canceled error on abort. */
  guard<T>(send: () => Promise<T>): Promise<T>;
};

const NO_REQUEST_GUARD: RequestGuard = {
  refuseIfAborted: () => {},
  guard: async <T>(send: () => Promise<T>) => await send(),
};

export function createRequestGuard(params: {
  signal: AbortSignal | undefined;
  requestId?: string;
}): RequestGuard {
  const { signal, requestId } = params;
  if (!signal) return NO_REQUEST_GUARD;
  return {
    refuseIfAborted() {
      if (signal.aborted) throw abortedRequestError(signal, 'no', requestId);
    },
    guard: async <T>(send: () => Promise<T>): Promise<T> => {
      // Checked before `send` runs, so nothing has been dispatched yet — the honest evidence is
      // 'no'. An abort listener attached to an already-aborted signal never fires, so this check is
      // what keeps a late `guard` call rejecting rather than pending forever.
      if (signal.aborted) throw abortedRequestError(signal, 'no', requestId);
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortedRequestError(signal, 'unknown', requestId));
        signal.addEventListener('abort', onAbort, { once: true });
        void send().then(
          (value) => {
            signal.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
    },
  };
}
