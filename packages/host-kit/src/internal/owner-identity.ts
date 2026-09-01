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

export type OwnerLiveness =
  | 'live'
  | 'owner-process-dead'
  | 'owner-process-reused'
  | 'owner-state-dir-gone'
  | 'unknown';

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
 * Positive proof that two records name DIFFERENT processes. Deliberately not
 * the negation of {@link ownerIdentityMatches}: equal pids with an unreadable
 * start time on either side are unproven rather than different, so a caller
 * that acts on this can never mistake one owner for two and hand its resource
 * away.
 */
export function ownerIdentityDiffers(
  left: Pick<OwnerIdentity, 'pid' | 'startTime'>,
  right: Pick<OwnerIdentity, 'pid' | 'startTime'>,
): boolean {
  if (left.pid !== right.pid) return true;
  return Boolean(left.startTime && right.startTime && left.startTime !== right.startTime);
}

/**
 * This is deliberately proof-oriented, in both directions. A filesystem read
 * error is not proof that an owner state directory disappeared, so callers
 * must surface it as an unknown owner rather than treating the resource as
 * free. Likewise a failed `ps` read (it shells out with a short timeout and
 * loses under CPU contention) is not proof the owner died, so it never
 * condemns a pid that kill(pid, 0) says is alive. Death is only concluded
 * from positive evidence: the pid is gone or the process is a zombie (already
 * terminated, merely unreaped). A different readable start time proves PID
 * reuse, but remains a distinct result so each ownership policy must decide
 * explicitly whether that proof permits recovery. An unreadable start time is
 * not proof of reuse. An owner recorded without a start time stays fail-closed
 * while its pid is alive: there is no same-clock-domain proof of birth order (wall-clock
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
      return 'owner-process-reused';
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
