import { AppError, createRequestCanceledError } from './errors.ts';

/** Cancels the wait while retaining handlers for the underlying operation. */
export async function awaitWithSignal<T>(
  pending: Promise<T>,
  signal?: AbortSignal,
  onAbort: () => unknown = () => {
    const reason: unknown = signal?.reason;
    if (reason instanceof AppError) return reason;
    if (reason instanceof Error && reason.name === 'TimeoutError')
      return new AppError(
        'COMMAND_FAILED',
        'Operation deadline expired',
        {
          reason: 'operation_deadline_expired',
        },
        reason,
      );
    if (reason instanceof Error && reason.name !== 'AbortError') return reason;
    return createRequestCanceledError(undefined, reason);
  },
): Promise<T> {
  if (!signal) return await pending;
  return await new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      try {
        reject(onAbort());
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
  });
}
