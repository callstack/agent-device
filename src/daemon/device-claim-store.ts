import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync, acquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { StoredDeviceClaim } from './device-claim-record.ts';

const DEVICE_CLAIM_LOCK_TIMEOUT_MS = 30_000;

/** The single writer of a claim file, shared by the process-owned and allocator-held kinds. */
export function writeDeviceClaim(claim: StoredDeviceClaim): void {
  const claimPath = resolveDeviceClaimPath(claim.deviceKey);
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
  task: () => Promise<T>,
): Promise<T> {
  const owner = readCurrentOwnerIdentity();
  const release = await acquireProcessLock({
    lockDirPath: `${resolveDeviceClaimPath(deviceKey)}.lock`,
    owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
    timeoutMs: DEVICE_CLAIM_LOCK_TIMEOUT_MS,
    description: `device claim for ${deviceKey}`,
  });
  try {
    return await task();
  } finally {
    await release();
  }
}
