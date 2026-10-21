import { AsyncLocalStorage } from 'node:async_hooks';

type LockFrame = {
  locks: Map<string, Promise<unknown>>;
  key: string;
  active: boolean;
  descendants: Set<Promise<void>>;
};

const keyedLockStorage = new AsyncLocalStorage<LockFrame[]>();

export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const activeLocks = keyedLockStorage.getStore() ?? [];
  const held = activeLocks.find(
    (entry) => entry.active && entry.locks === locks && entry.key === key,
  );
  if (held) {
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    held.descendants.add(settled);
    try {
      return await task();
    } finally {
      held.descendants.delete(settled);
      markSettled();
    }
  }
  const previous = locks.get(key) ?? Promise.resolve();
  let entered = false;
  const current = previous
    .catch(() => {})
    .then(async () => {
      entered = true;
      signal?.throwIfAborted();
      const frame: LockFrame = { locks, key, active: true, descendants: new Set() };
      try {
        return await keyedLockStorage.run(
          [...activeLocks.filter((entry) => entry.active), frame],
          task,
        );
      } finally {
        while (frame.descendants.size > 0) await Promise.all(frame.descendants);
        frame.active = false;
      }
    });
  locks.set(key, current);
  const completion = current.finally(() => {
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  });
  if (!signal) return await completion;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!entered) reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    completion.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}
