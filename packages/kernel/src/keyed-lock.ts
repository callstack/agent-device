import { AsyncLocalStorage } from 'node:async_hooks';

type LockFrame = {
  locks: Map<string, Promise<unknown>>;
  key: string;
};

const keyedLockStorage = new AsyncLocalStorage<LockFrame[]>();

export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const activeLocks = keyedLockStorage.getStore() ?? [];
  if (activeLocks.some((entry) => entry.locks === locks && entry.key === key)) {
    return await task();
  }
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => {})
    .then(() => keyedLockStorage.run([...activeLocks, { locks, key }], task));
  locks.set(key, current);
  return current.finally(() => {
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  });
}
