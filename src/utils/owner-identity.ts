import fs from 'node:fs';
import { isProcessAlive, readProcessStartTime } from './host-process.ts';

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
 * This is deliberately proof-oriented. A filesystem read error is not proof
 * that an owner state directory disappeared, so callers must surface it as an
 * unknown owner rather than treating the resource as free.
 */
export function classifyOwnerLiveness(params: {
  owner: Pick<OwnerIdentity, 'pid' | 'startTime'>;
  stateDir?: string;
}): OwnerLiveness {
  const { owner, stateDir } = params;
  if (!isProcessAlive(owner.pid)) return 'owner-process-dead';
  if (owner.startTime && readProcessStartTime(owner.pid) !== owner.startTime) {
    return 'owner-process-dead';
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
