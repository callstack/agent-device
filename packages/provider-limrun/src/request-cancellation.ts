/**
 * The Limrun WebSocket client does not expose an AbortSignal parameter. Keep the request-bound
 * caller cancellable while retaining a handled continuation for the provider operation it started.
 */
export async function awaitLimrunOperation<Value>(
  source: Promise<Value>,
  signal?: AbortSignal,
  abortMessage = 'Limrun provider operation aborted',
  onSettled?: () => void,
): Promise<Value> {
  if (!signal) {
    try {
      return await source;
    } finally {
      onSettled?.();
    }
  }
  return await new Promise<Value>((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error(abortMessage));
    if (signal.aborted) {
      void source.then(
        (value) => {
          onSettled?.();
          resolve(value);
        },
        (error: unknown) => {
          onSettled?.();
          reject(error);
        },
      );
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    void source.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        onSettled?.();
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        onSettled?.();
        reject(error);
      },
    );
  });
}

/**
 * Request-local ownership for an opaque Limrun WebSocket operation. A caller can observe its own
 * abort immediately, but a bound runtime does not release the provider session until every
 * accepted operation has settled. This is deliberately not a durable resource or daemon policy.
 */
export type LimrunRequestOperationDrain = AsyncDisposable & {
  wait<Value>(source: Promise<Value>, signal?: AbortSignal, abortMessage?: string): Promise<Value>;
};

export function createLimrunRequestOperationDrain(): LimrunRequestOperationDrain {
  const pending = new Set<Promise<void>>();
  return {
    wait: async <Value>(source: Promise<Value>, signal?: AbortSignal, abortMessage?: string) => {
      let settled!: () => void;
      const completion = new Promise<void>((resolve) => {
        settled = () => {
          pending.delete(completion);
          resolve();
        };
      });
      pending.add(completion);
      return await awaitLimrunOperation(source, signal, abortMessage, settled);
    },
    [Symbol.asyncDispose]: async () => {
      while (pending.size > 0) {
        await Promise.all(pending);
      }
    },
  };
}

export async function awaitLimrunDeploymentOperation<Value>(
  drain: LimrunRequestOperationDrain | undefined,
  source: Promise<Value>,
  signal?: AbortSignal,
  abortMessage?: string,
): Promise<Value> {
  return await (drain
    ? drain.wait(source, signal, abortMessage)
    : awaitLimrunOperation(source, signal, abortMessage));
}
