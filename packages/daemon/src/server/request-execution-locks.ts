import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { hostDeviceIdOf } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
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
        const heldKeys = [...initialKeySet, ...retainedLocks.keys()];
        if (holdsDeviceOfSameHost(deviceId, heldKeys) && locks.has(key)) {
          throw deviceExecutionLockBusy(deviceId);
        }
        retained = retainExecutionLock(locks, key, scope?.signal);
        retainedLocks.set(key, retained);
      }
      await retained.acquired;
    },
  };
}

/**
 * Whether the request already holds a lock on `deviceId`'s host or one of its app devices
 * (ADR 0035). Waiting for a second lock on the same host while holding one could cross another
 * request that does the same in the other order: replays on two apps of one Mac that each close
 * their app and open the other's, or a replay that leaves its app for the whole Mac while a fresh
 * open holds the Mac and waits for that app. Such a lock is taken only while it is free.
 */
function holdsDeviceOfSameHost(
  deviceId: string,
  heldKeys: readonly RequestExecutionLockKey[],
): boolean {
  const host = hostDeviceIdOf(deviceId);
  return heldKeys.some(
    (key) => key.startsWith('device:') && hostDeviceIdOf(key.slice('device:'.length)) === host,
  );
}

function deviceExecutionLockBusy(deviceId: string): AppError {
  return new AppError(
    'DEVICE_IN_USE',
    `Another request is using ${deviceId}, and this request already holds another device of the same host.`,
    {
      reason: 'DEVICE_EXECUTION_LOCK_BUSY',
      deviceId,
      hint: 'Run this step as a separate request, or retry once the other request finishes.',
    },
  );
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
