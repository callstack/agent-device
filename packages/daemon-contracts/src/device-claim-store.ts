import fs from 'node:fs';
import path from 'node:path';
import {
  acquireProcessLock,
  publishFileSync,
  tryAcquireProcessLock,
  withProcessLock,
} from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { EnvMap } from '@agent-device/kernel/source-value';

import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { DeviceClaim } from './device-claim-record.ts';

const DEVICE_CLAIM_LOCK_TIMEOUT_MS = 30_000;

/** The single writer of a claim file. */
export function writeDeviceClaim(claim: DeviceClaim, env: EnvMap): void {
  const claimPath = resolveDeviceClaimPath(claim.deviceKey, env);
  fs.mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 });
  publishFileSync({
    destination: claimPath,
    contents: `${JSON.stringify(claim)}\n`,
    mode: 0o600,
  });
}

/** The host-global per-device mutual exclusion every claim write and clear runs under. */
export async function withDeviceClaimLock<T>(
  deviceKey: string,
  env: EnvMap,
  task: () => Promise<T>,
): Promise<T> {
  const owner = readCurrentOwnerIdentity();
  return await withProcessLock({
    acquire: () =>
      acquireProcessLock({
        lockDirPath: deviceClaimLockPath(deviceKey, env),
        owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
        timeoutMs: DEVICE_CLAIM_LOCK_TIMEOUT_MS,
        description: `device claim for ${deviceKey}`,
      }),
    task,
  });
}

/**
 * What {@link withDeviceClaimLockHeld} reports: `ran` carries what the callback returned; `conflict`
 * says the device's claim lock belongs to somebody else — or cannot be proved free — and the callback
 * never ran. Both are the same answer to a caller that only cleans up: the device is being claimed.
 */
export type DeviceClaimLockHeld<Result> =
  | Readonly<{ status: 'ran'; result: Result }>
  | Readonly<{ status: 'conflict' }>;

/**
 * Runs `task` while this process holds the device's claim lock — the same lock `acquireDeviceClaim`
 * takes to write a claim — so no owner can be acquired for the device between what `task` reads about
 * the device and what `task` does to it.
 *
 * The lock is taken without waiting, which is what a caller that only cleans up needs: acquisition
 * holds this lock for the one short transaction that writes or clears a claim, so a lock this process
 * cannot take says somebody is claiming the device right now. Such a device is left alone rather than
 * waited for. While the callback runs, any other acquisition of this device's lock, from this process
 * or another, waits behind it.
 *
 * `task` must be bounded and must not take this device's claim lock itself: this process's own
 * standing claim reports a conflict.
 */
export async function withDeviceClaimLockHeld<Result>(
  deviceKey: string,
  env: EnvMap,
  task: () => Promise<Result>,
): Promise<DeviceClaimLockHeld<Result>> {
  const owner = readCurrentOwnerIdentity();
  const attempt = tryAcquireProcessLock({
    lockDirPath: deviceClaimLockPath(deviceKey, env),
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    description: `device claim for ${deviceKey}`,
  });
  if (attempt.status !== 'acquired') return { status: 'conflict' };
  try {
    return { status: 'ran', result: await task() };
  } finally {
    await attempt.acquisition.release();
  }
}

function deviceClaimLockPath(deviceKey: string, env: EnvMap): string {
  return `${resolveDeviceClaimPath(deviceKey, env)}.lock`;
}
