import fs from 'node:fs';
import {
  ownerIdentityDiffers,
  ownerIdentityMatches,
  type OwnerIdentity,
} from '@agent-device/host-kit/process';
import { resolveDaemonPaths } from './daemon-resolution.ts';

/**
 * The daemon identity published in a state dir's `daemon.json`. It is the only
 * answer to "which process serves this state dir": clients discover a daemon
 * through this record, so a process that is not named here receives no request
 * however alive it is.
 */
export function readRegisteredDaemonIdentity(infoPath: string): OwnerIdentity | null {
  const record = readRegistration(infoPath);
  return record.status === 'registered' ? record.identity : null;
}

/** The raw record's identity. A pid of `null` is a file that names no owner, not owner zero. */
type ParsedRegistration = { pid: number | null; startTime: string | null };

function readRegistration(
  infoPath: string,
):
  | Readonly<{ status: 'registered'; identity: OwnerIdentity }>
  | Readonly<{ status: 'absent' | 'unreadable' | 'ownerless' }> {
  let raw: string;
  try {
    raw = fs.readFileSync(infoPath, 'utf8');
  } catch (error) {
    // Only a path the host reports as gone proves there is no record. A permission error, an I/O
    // fault, or a read this process lost leaves a file present whose contents are unknown, which no
    // caller may read as "someone removed it".
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { status: 'absent' }
      : { status: 'unreadable' };
  }
  let parsed: ParsedRegistration;
  try {
    parsed = parseRegistration(JSON.parse(raw) as { pid?: unknown; processStartTime?: unknown });
  } catch {
    return { status: 'ownerless' };
  }
  return parsed.pid === null
    ? { status: 'ownerless' }
    : { status: 'registered', identity: { pid: parsed.pid, startTime: parsed.startTime } };
}

function parseRegistration(parsed: {
  pid?: unknown;
  processStartTime?: unknown;
}): ParsedRegistration {
  const pid = parsed.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return { pid: null, startTime: null };
  }
  return { pid, startTime: readableStartTime(parsed.processStartTime) };
}

/**
 * Whether `daemon.json` still names `owner` as the daemon serving its state dir, in one read.
 *
 * Three verdicts, because ownership here is proved rather than assumed, and a pid alone proves
 * nothing: it cannot tell the owner from the process that recycled its number. `match` needs a start
 * time readable on both sides to agree, since every caller acts on it by deleting the record.
 * `replaced` is the opposite proof, from {@link ownerIdentityDiffers}. `unproven` is neither, and is
 * kept distinct from `replaced` because it describes a record this daemon cannot place — ours by pid
 * and unreadable by birth — so a caller that reports a takeover would be reporting an event that did
 * not happen.
 *
 * `absent`, `unreadable`, and `ownerless` stay separate too: only `absent` describes a record somebody
 * removed, while a file that is present but unreadable or names no owner is still on disk.
 */
export type RegisteredDaemonOwnership =
  | Readonly<{ state: 'match' }>
  | Readonly<{ state: 'replaced'; identity: OwnerIdentity }>
  | Readonly<{ state: 'unproven' | 'absent' | 'unreadable' | 'ownerless' }>;

export function readRegisteredDaemonOwnership(
  infoPath: string,
  owner: OwnerIdentity | null,
): RegisteredDaemonOwnership {
  const record = readRegistration(infoPath);
  if (record.status !== 'registered') return { state: record.status };
  if (!owner) return { state: 'unproven' };
  if (ownerIdentityDiffers(record.identity, owner)) {
    return { state: 'replaced', identity: record.identity };
  }
  // Two missing start times agree, and agreeing on nothing is not ownership: this is the pid-only
  // fallback the fence exists to refuse, so it falls to `unproven` rather than to `match`.
  if (ownerIdentityMatches(record.identity, owner) && record.identity.startTime !== null) {
    return { state: 'match' };
  }
  return { state: 'unproven' };
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
