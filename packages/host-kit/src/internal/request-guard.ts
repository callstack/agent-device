import { createRequestCanceledError, type AppError } from '@agent-device/kernel/errors';

/**
 * The requester-side half of a per-call `AbortSignal`. The transport half closes the request's
 * connection so the daemon marks the request canceled (its own cancellation machinery is
 * {@link ./request-cancel.ts}); this half answers for the two cases a transport cannot:
 *
 * - a signal already aborted before anything was sent — nothing may leave the process, so the
 *   refusal carries `details.dispatched: 'no'`;
 * - a custom transport that ignores the signal it was handed — the caller's promise must still
 *   settle when the abort fires, with `details.dispatched: 'unknown'` because the transport may
 *   already have written the request.
 *
 * Both outcomes reject with the typed canceled-request error (`details.reason:
 * 'request_canceled'`) whatever reason the caller's own controller aborted with, so every layer
 * that lets a cancellation through dispatches on the same reason — and never on the caller's
 * arbitrary abort reason or on error text. An abort is never a timeout: nothing here reads or
 * extends a request deadline, and no timeout path may produce this rejection.
 */

export type RequestGuard = {
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
  const canceled = (dispatched: 'no' | 'unknown'): AppError =>
    createRequestCanceledError(
      { requestId, dispatched },
      signal.reason instanceof Error ? signal.reason : undefined,
    );
  return {
    refuseIfAborted() {
      if (signal.aborted) throw canceled('no');
    },
    guard: async <T>(send: () => Promise<T>): Promise<T> => {
      if (signal.aborted) throw canceled('unknown');
      return await new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(canceled('unknown'));
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
