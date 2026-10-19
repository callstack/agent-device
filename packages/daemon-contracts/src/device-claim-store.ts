import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync, acquireProcessLock, withProcessLock } from '@agent-device/host-kit/file';
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
        lockDirPath: `${resolveDeviceClaimPath(deviceKey, env)}.lock`,
        owner: { pid: owner.pid, startTime: owner.startTime, acquiredAtMs: Date.now() },
        timeoutMs: DEVICE_CLAIM_LOCK_TIMEOUT_MS,
        description: `device claim for ${deviceKey}`,
      }),
    task,
  });
}
