import fs from 'node:fs';
import path from 'node:path';
import {
  publishFileSync,
  acquireProcessLockAcquisition,
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
  return await withProcessLock({
    acquire: async () => (await acquireDeviceClaimLock(deviceKey, env)).release,
    task,
  });
}

export async function acquireDeviceClaimLock(deviceKey: string, env: EnvMap) {
  const owner = readCurrentOwnerIdentity();
  return await acquireProcessLockAcquisition({
    lockDirPath: `${resolveDeviceClaimPath(deviceKey, env)}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    timeoutMs: DEVICE_CLAIM_LOCK_TIMEOUT_MS,
    description: `device claim for ${deviceKey}`,
  });
}

export function tryDeviceClaimLock(deviceKey: string, env: EnvMap) {
  const owner = readCurrentOwnerIdentity();
  return tryAcquireProcessLock({
    lockDirPath: `${resolveDeviceClaimPath(deviceKey, env)}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    description: `device claim for ${deviceKey}`,
  });
}
