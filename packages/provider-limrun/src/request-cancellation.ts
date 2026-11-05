import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
/**
 * The Limrun WebSocket client does not expose an AbortSignal parameter. Keep the request-bound
 * caller cancellable while retaining a handled continuation for the provider operation it started.
 */
export async function awaitLimrunOperation<Value>(
  source: Promise<Value>,
  signal?: AbortSignal,
  onSettled?: () => void,
): Promise<Value> {
  return await awaitWithSignal(source.finally(onSettled), signal);
}

/**
 * Request-local ownership for an opaque Limrun WebSocket operation. A caller can observe its own
 * abort immediately, but a bound runtime does not release the provider session until every
 * accepted operation has settled. This is deliberately not a durable resource or daemon policy.
 */
export type LimrunRequestOperationDrain = AsyncDisposable & {
  wait<Value>(source: Promise<Value>, signal?: AbortSignal): Promise<Value>;
};

export function createLimrunRequestOperationDrain(): LimrunRequestOperationDrain {
  const pending = new Set<Promise<void>>();
  return {
    wait: async <Value>(source: Promise<Value>, signal?: AbortSignal) => {
      let settled!: () => void;
      const completion = new Promise<void>((resolve) => {
        settled = () => {
          pending.delete(completion);
          resolve();
        };
      });
      pending.add(completion);
      return await awaitLimrunOperation(source, signal, settled);
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
): Promise<Value> {
  return await (drain ? drain.wait(source, signal) : awaitLimrunOperation(source, signal));
}
