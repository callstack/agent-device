import crypto from 'node:crypto';
import path from 'node:path';
import { acquireProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { AllocationOperationStore } from './store.ts';

const LOCK_TIMEOUT_MS = 30_000;

export function createAllocationStoreLaneLock(
  allocationsDir: string,
): AllocationOperationStore['withLaneLock'] {
  return <T>(requesterId: string, task: () => Promise<T>) =>
    withAllocationLaneLock(allocationsDir, requesterId, task);
}

async function withAllocationLaneLock<T>(
  allocationsDir: string,
  requesterId: string,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquireAllocationStoreLock(
    path.join(allocationsDir, `${hash(requesterId)}.lane.lock`),
    `allocation lane ${requesterId}`,
  );
  try {
    return await task();
  } finally {
    await release();
  }
}

export function acquireAllocationStoreLock(
  lockDirPath: string,
  description: string,
): Promise<() => Promise<void>> {
  const owner = readCurrentOwnerIdentity();
  return acquireProcessLock({
    lockDirPath,
    owner: {
      pid: owner.pid,
      startTime: owner.startTime,
      acquiredAtMs: Date.now(),
    },
    timeoutMs: LOCK_TIMEOUT_MS,
    description,
  });
}

export function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
