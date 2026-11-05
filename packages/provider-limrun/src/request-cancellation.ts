import { awaitWithSignal } from '@agent-device/kernel/await-with-signal';
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
      return await awaitWithSignal(source.finally(settled), signal);
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
  return await (drain ? drain.wait(source, signal) : awaitWithSignal(source, signal));
}
