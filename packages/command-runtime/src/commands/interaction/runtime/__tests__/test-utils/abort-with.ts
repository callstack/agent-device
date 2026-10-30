export function abortWith(signal: AbortSignal | undefined, error: unknown): Promise<never> {
  if (!signal) return Promise.reject(new Error('the wait deadline never reached the capture'));
  return new Promise((_resolve, reject) => {
    const cancel = () => reject(error);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}
