import fs from 'node:fs';
import { ownerIdentityDiffers, type OwnerIdentity } from '../utils/owner-identity.ts';
import { resolveDaemonPaths } from './config.ts';

/**
 * The daemon identity published in a state dir's `daemon.json`. It is the only
 * answer to "which process serves this state dir": clients discover a daemon
 * through this record, so a process that is not named here receives no request
 * however alive it is.
 */
export function readRegisteredDaemonIdentity(infoPath: string): OwnerIdentity | null {
  try {
    const { pid, processStartTime } = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as {
      pid?: unknown;
      processStartTime?: unknown;
    };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startTime: readableStartTime(processStartTime) };
  } catch {
    return null;
  }
}

function readableStartTime(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * #2031: positive proof that `owner` is no longer the daemon serving its own
 * state dir, and so can never be asked to release what it holds — its sessions
 * are unreachable and `session list` cannot even report them.
 *
 * Proof runs one way only, on top of the one-way comparison in
 * {@link ownerIdentityDiffers}. The reading process is never superseded: a
 * caller had to reach it to ask. Nor is a missing or unreadable registration
 * proof, because a daemon publishes its record only after startup recovery, so
 * absence equally describes one that is about to be reachable.
 */
export function isSupersededDaemonOwner(owner: OwnerIdentity & { stateDir: string }): boolean {
  if (owner.pid === process.pid) return false;
  const registered = readRegisteredDaemonIdentity(resolveDaemonPaths(owner.stateDir).infoPath);
  return registered !== null && ownerIdentityDiffers(registered, owner);
}
