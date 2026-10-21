import { AsyncLocalStorage } from 'node:async_hooks';
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
 * The locks each enclosing request holds, innermost last. A request nested in another (a batch
 * step) takes its own locks while the enclosing request still holds its own, so the same-host rule
 * below applies to the locks it takes up front as much as to the ones it retains later.
 */
const enclosingRequestLocks = new AsyncLocalStorage<
  readonly ReadonlySet<RequestExecutionLockKey>[]
>();

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
  // Every lock this request holds, for the requests nested in it to see.
  const heldLocks = new Set<RequestExecutionLockKey>();
  const enclosing = (): readonly ReadonlySet<RequestExecutionLockKey>[] =>
    enclosingRequestLocks.getStore() ?? [];
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
      const outer = enclosing();
      const heldOutside = outer.flatMap((held) => [...held]);
      try {
        return await withRequestExecutionLockKeys(
          locks,
          initialKeys,
          async () => await enclosingRequestLocks.run([...outer, heldLocks], task),
          scope?.signal,
          (key) => {
            // An enclosing request already holding this lock re-enters it without waiting.
            if (!heldOutside.includes(key)) assertSameHostLockFree(locks, key, heldOutside);
            heldLocks.add(key);
          },
        );
      } finally {
        heldLocks.clear();
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
      // An enclosing request already holds it, and this request runs inside that hold.
      if (enclosing().some((held) => held.has(key))) return;

      let retained = retainedLocks.get(key);
      if (!retained) {
        const heldKeys = [...heldLocks, ...enclosing().flatMap((held) => [...held])];
        assertSameHostLockFree(locks, key, heldKeys);
        retained = retainExecutionLock(locks, key, scope?.signal);
        retainedLocks.set(key, retained);
        heldLocks.add(key);
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
function assertSameHostLockFree(
  locks: Map<string, Promise<unknown>>,
  key: RequestExecutionLockKey,
  heldKeys: readonly RequestExecutionLockKey[],
): void {
  if (!key.startsWith('device:')) return;
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
