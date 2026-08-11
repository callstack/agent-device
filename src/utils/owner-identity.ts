import fs from 'node:fs';
import {
  isProcessAlive,
  isProcessZombie,
  readProcessStartTime,
  type HostProcessIdentityObservation,
} from './host-process.ts';

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
 * terminated, merely unreaped), or its start time differs from the recorded
 * one. An owner recorded without a start time stays fail-closed while its pid
 * is alive: there is no same-clock-domain proof of birth order (wall-clock
 * arithmetic over `ps etime` shifts under clock steps), and misreading a live
 * owner as recycled would let a waiter steal a held resource.
 */
export function classifyOwnerLiveness(params: {
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
  stateDir?: string;
}): OwnerLiveness {
  return classifyOwnerLivenessFromObservation(params);
}

export function classifyOwnerLivenessFromObservation(
  params: {
    owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
    stateDir?: string;
  },
  observation?: HostProcessIdentityObservation | null,
): OwnerLiveness {
  const { owner, stateDir } = params;
  if (!isProcessAlive(owner.pid)) return 'owner-process-dead';
  if (observation !== undefined ? observation?.state.startsWith('Z') : isProcessZombie(owner.pid)) {
    return 'owner-process-dead';
  }
  if (owner.startTime) {
    const currentStartTime =
      observation !== undefined
        ? (observation?.startTime ?? null)
        : readProcessStartTime(owner.pid);
    if (currentStartTime !== null && currentStartTime !== owner.startTime) {
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
