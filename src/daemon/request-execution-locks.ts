import { withKeyedLock } from '../utils/keyed-lock.ts';
import type { RequestExecutionLockKey } from './request-binding.ts';

type RetainedExecutionLock = {
  acquired: Promise<void>;
  completion: Promise<void>;
  release(): void;
};

export type RequestExecutionLocks = {
  run<T>(task: () => Promise<T>): Promise<T>;
  retainDevice(deviceId: string): Promise<void>;
};

/**
 * Owns the stable execution locks for one request and any device lock discovered
 * after admission. Dynamic device retention is used by a fresh replay whose
 * first open cannot select its device during advisory preflight.
 */
export function createRequestExecutionLocks(params: {
  locks: Map<string, Promise<unknown>>;
  initialKeys: RequestExecutionLockKey[];
}): RequestExecutionLocks {
  const { locks, initialKeys } = params;
  const initialKeySet = new Set(initialKeys);
  const retainedLocks = new Map<RequestExecutionLockKey, RetainedExecutionLock>();
  let running = false;

  const releaseRetainedLocks = async (): Promise<void> => {
    const held = [...retainedLocks.values()];
    for (const lock of held) lock.release();
    await Promise.all(held.map(async (lock) => await lock.completion));
    retainedLocks.clear();
  };

  return {
    run: async (task) => {
      if (running) {
        throw new Error('Request execution locks cannot run the same scope concurrently.');
      }
      running = true;
      try {
        return await withRequestExecutionLocks(locks, initialKeys, task);
      } finally {
        try {
          await releaseRetainedLocks();
        } finally {
          running = false;
        }
      }
    },
    retainDevice: async (deviceId) => {
      if (!running) {
        throw new Error('A device execution lock can only be retained by a running request.');
      }
      const key = `device:${deviceId}` as const;
      if (initialKeySet.has(key)) return;

      let retained = retainedLocks.get(key);
      if (!retained) {
        retained = retainExecutionLock(locks, key);
        retainedLocks.set(key, retained);
      }
      await retained.acquired;
    },
  };
}

async function withRequestExecutionLocks<T>(
  locks: Map<string, Promise<unknown>>,
  keys: RequestExecutionLockKey[],
  task: () => Promise<T>,
): Promise<T> {
  const [key, ...remainingKeys] = keys;
  if (!key) return await task();
  return await withKeyedLock(
    locks,
    key,
    async () => await withRequestExecutionLocks(locks, remainingKeys, task),
  );
}

function retainExecutionLock(
  locks: Map<string, Promise<unknown>>,
  key: RequestExecutionLockKey,
): RetainedExecutionLock {
  let markAcquired: () => void = () => {};
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completion = withKeyedLock(locks, key, async () => {
    markAcquired();
    await released;
  });
  return { acquired, completion, release };
}
