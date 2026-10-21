import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
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
  scope?: Readonly<{ signal: AbortSignal }>;
}): RequestExecutionLocks {
  const { locks, initialKeys, scope } = params;
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
        return await withRequestExecutionLockKeys(locks, initialKeys, task, scope?.signal);
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
        retained = retainExecutionLock(locks, key, scope?.signal);
        retainedLocks.set(key, retained);
      }
      await retained.acquired;
    },
  };
}

export async function withRequestExecutionLockKeys<T>(
  locks: Map<string, Promise<unknown>>,
  keys: readonly RequestExecutionLockKey[],
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const [key, ...remainingKeys] = keys;
  if (!key) return await task();
  return await withKeyedLock(
    locks,
    key,
    async () => await withRequestExecutionLockKeys(locks, remainingKeys, task, signal),
    signal,
  );
}

function retainExecutionLock(
  locks: Map<string, Promise<unknown>>,
  key: RequestExecutionLockKey,
  signal?: AbortSignal,
): RetainedExecutionLock {
  let markAcquired: () => void = () => {};
  let rejectAcquired: (error: unknown) => void = () => {};
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    rejectAcquired = reject;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completion = withKeyedLock(
    locks,
    key,
    async () => {
      markAcquired();
      await released;
    },
    signal,
  );
  void completion.catch((error) => rejectAcquired(error));
  return { acquired, completion, release };
}
