import fs from 'node:fs';
import {
  isProcessAlive,
  isProcessZombie,
  readProcessStartedAtMs,
  readProcessStartTime,
} from './host-process.ts';

// ps reports process start times at second granularity and the host clock can
// step; a current start time must clear acquiredAtMs by this margin before it
// proves the pid was recycled.
const OWNER_START_TIME_SLACK_MS = 30_000;

export type OwnerIdentity = {
  pid: number;
  startTime: string | null;
};

export type OwnerLiveness = 'live' | 'owner-process-dead' | 'owner-state-dir-gone' | 'unknown';

export function readCurrentOwnerIdentity(): OwnerIdentity {
  return { pid: process.pid, startTime: readProcessStartTime(process.pid) };
}

export function ownerIdentityMatches(
  left: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  right: Pick<OwnerIdentity, 'pid' | 'startTime'>,
): boolean {
  return left.pid === right.pid && left.startTime === right.startTime;
}

/**
 * This is deliberately proof-oriented, in both directions. A filesystem read
 * error is not proof that an owner state directory disappeared, so callers
 * must surface it as an unknown owner rather than treating the resource as
 * free. Likewise a failed `ps` read (it shells out with a short timeout and
 * loses under CPU contention) is not proof the owner died, so it never
 * condemns a pid that kill(pid, 0) says is alive. Death is only concluded
 * from positive evidence: the pid is gone, the process is a zombie (already
 * terminated, merely unreaped), its start time differs from the recorded one,
 * or it started after `acquiredAtMs` — a process born after the resource was
 * acquired cannot be the acquirer, which catches recycled pids even when the
 * owner's start time was never recorded.
 */
export function classifyOwnerLiveness(params: {
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
  stateDir?: string;
  acquiredAtMs?: number;
}): OwnerLiveness {
  const { owner, stateDir, acquiredAtMs } = params;
  if (!isProcessAlive(owner.pid)) return 'owner-process-dead';
  if (isProcessZombie(owner.pid)) return 'owner-process-dead';
  if (owner.startTime) {
    const currentStartTime = readProcessStartTime(owner.pid);
    if (currentStartTime !== null && currentStartTime !== owner.startTime) {
      return 'owner-process-dead';
    }
  } else if (acquiredAtMs !== undefined) {
    const startedAtMs = readProcessStartedAtMs(owner.pid);
    if (startedAtMs !== null && startedAtMs > acquiredAtMs + OWNER_START_TIME_SLACK_MS) {
      return 'owner-process-dead';
    }
  }
  if (!stateDir) return 'live';
  try {
    fs.statSync(stateDir);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'owner-state-dir-gone';
    return 'unknown';
  }
}
