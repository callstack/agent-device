import {
  heldKeyedLockKeys,
  withKeyedLock,
  withKeyedLockHolder,
  type KeyedLockHolder,
} from '@agent-device/kernel/keyed-lock';
import { hostDeviceIdOf } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { RequestExecutionLockKey } from './request-binding.ts';

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
  let holder: KeyedLockHolder | undefined;
  let running = false;

  return {
    run: async (task) => {
      if (running) {
        throw new Error('Request execution locks cannot run the same scope concurrently.');
      }
      running = true;
      // What the requests this one is nested in hold (a batch step runs inside its batch). Its own
      // initial keys are taken in sorted order, waiting for each in turn.
      const heldOutside = heldRequestLockKeys(locks);
      try {
        return await withRequestExecutionLockKeys(
          locks,
          initialKeys,
          async () =>
            await withKeyedLockHolder(async (taken) => {
              holder = taken;
              return await task();
            }),
          scope?.signal,
          (key) => assertSameHostLockFree(locks, key, heldOutside),
        );
      } finally {
        holder = undefined;
        running = false;
      }
    },
    retainDevice: async (deviceId) => {
      if (!holder) {
        throw new Error('A device execution lock can only be retained by a running request.');
      }
      const key = `device:${deviceId}` as const;
      assertSameHostLockFree(locks, key, heldRequestLockKeys(locks));
      await holder.hold(locks, key, scope?.signal);
    },
  };
}

function heldRequestLockKeys(locks: Map<string, Promise<unknown>>): RequestExecutionLockKey[] {
  return heldKeyedLockKeys(locks) as RequestExecutionLockKey[];
}

/**
 * Whether the request already holds a lock on `deviceId`'s host or one of its app devices
 * (ADR 0035). Waiting for a second lock on the same host while holding one could cross another
 * request that does the same in the other order: replays on two apps of one Mac that each close
 * their app and open the other's, or a replay that leaves its app for the whole Mac while a fresh
 * open holds the Mac and waits for that app. Such a lock is taken only while it is free.
 */
function assertSameHostLockFree(
  locks: Map<string, Promise<unknown>>,
  key: RequestExecutionLockKey,
  heldKeys: readonly RequestExecutionLockKey[],
): void {
  // A held key re-enters, and only device keys belong to a host.
  if (heldKeys.includes(key) || !key.startsWith('device:')) return;
  const deviceId = key.slice('device:'.length);
  if (holdsDeviceOfSameHost(deviceId, heldKeys) && locks.has(key)) {
    throw deviceExecutionLockBusy(deviceId);
  }
}

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

/**
 * Takes `keys` in order, then runs `task`. `beforeAcquire` runs synchronously just before each
 * key is taken, so a check it makes cannot go stale before the lock is queued.
 */
export async function withRequestExecutionLockKeys<T>(
  locks: Map<string, Promise<unknown>>,
  keys: readonly RequestExecutionLockKey[],
  task: () => Promise<T>,
  signal?: AbortSignal,
  beforeAcquire?: (key: RequestExecutionLockKey) => void,
): Promise<T> {
  const [key, ...remainingKeys] = keys;
  if (!key) return await task();
  beforeAcquire?.(key);
  return await withKeyedLock(
    locks,
    key,
    async () =>
      await withRequestExecutionLockKeys(locks, remainingKeys, task, signal, beforeAcquire),
    signal,
  );
}
