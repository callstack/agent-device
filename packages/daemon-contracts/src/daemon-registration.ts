import type { ProcessLockInspection } from '@agent-device/host-kit/file';
import {
  isProcessAlive,
  ownerIdentityDiffers,
  isProcessPid,
  ownerIdentityMatches,
  readProcessStartTime,
  type OwnerIdentity,
} from '@agent-device/host-kit/process';
import {
  readDaemonRecord,
  readRecordedDaemonTransport,
  resolveDaemonPaths,
  type DaemonPaths,
  type DaemonServerMode,
} from './daemon-resolution.ts';

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

export function processLockHoldsDaemonIdentity(
  inspection: ProcessLockInspection,
  identity: OwnerIdentity,
): boolean {
  return (
    inspection.state === 'held' &&
    typeof identity.startTime === 'string' &&
    identity.startTime.trim().length > 0 &&
    ownerIdentityMatches(inspection.owner, identity)
  );
}

/** The raw record's identity. A pid of `null` is a file that names no owner, not owner zero. */
type ParsedRegistration = { pid: number | null; startTime: string | null };

type DaemonRecord = Readonly<Record<string, unknown>>;

/**
 * Whether `daemon.json` registers a daemon: a projection of the one record reader that adds the
 * identity, so a record that names no owner is `ownerless` however it came to.
 */
function readRegistration(
  infoPath: string,
):
  | Readonly<{ status: 'registered'; identity: OwnerIdentity; record: DaemonRecord }>
  | Readonly<{ status: 'absent' | 'unreadable' | 'ownerless' }> {
  const read = readDaemonRecord(infoPath);
  if (read.status !== 'present') {
    return { status: read.status === 'invalid' ? 'ownerless' : read.status };
  }
  const parsed = parseRegistration(read.record);
  return parsed.pid === null
    ? { status: 'ownerless' }
    : {
        status: 'registered',
        identity: { pid: parsed.pid, startTime: parsed.startTime },
        record: read.record,
      };
}

function parseRegistration(parsed: {
  pid?: unknown;
  processStartTime?: unknown;
}): ParsedRegistration {
  const pid = parsed.pid;
  if (!isProcessPid(pid)) {
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

/** What `daemon.json` says about the daemon serving a state dir, checked against the process. */
export type DaemonStatus = Readonly<{
  /**
   * `unreadable`: the record exists but cannot be read; `invalid`: it is not a record. Either way
   * whether a daemon runs is unknown.
   */
  state: 'running' | 'stopped' | 'unreadable' | 'invalid';
  stateDir: string;
  pid?: number;
  version?: string;
  transport?: DaemonServerMode;
  /**
   * The provider plugin inventory the running daemon published, as recorded; `readPluginInventory`
   * validates it where it is shown, so this module stays out of the inventory vocabulary's closure.
   */
  plugins?: unknown;
}>;

/** Whether the record exists but cannot say if a daemon runs: it is `unreadable` or `invalid`. */
export function isUnusableRecord(status: Pick<DaemonStatus, 'state'>): boolean {
  return status.state === 'unreadable' || status.state === 'invalid';
}

/**
 * Reads the daemon's published record without contacting it. The record counts while its pid names
 * a live process, unless a readable start time differs from the recorded one: a record a crashed
 * daemon left behind, or whose pid was reused, is `stopped`, and a failed start-time read does not
 * end the record.
 */
export function readDaemonStatus(paths: DaemonPaths): DaemonStatus {
  const base = { stateDir: paths.baseDir } as const;
  const read = readDaemonRecord(paths.infoPath);
  if (read.status !== 'present') {
    return read.status === 'absent'
      ? { state: 'stopped', ...base }
      : { state: read.status, ...base };
  }
  const { record } = read;
  const parsed = parseRegistration(record);
  if (parsed.pid === null) return { state: 'stopped', ...base };
  const identity = { pid: parsed.pid, startTime: parsed.startTime };
  if (identity.startTime === null || !isProcessAlive(identity.pid)) {
    return { state: 'stopped', ...base };
  }
  if (
    ownerIdentityDiffers(identity, {
      pid: identity.pid,
      startTime: readProcessStartTime(identity.pid),
    })
  ) {
    return { state: 'stopped', ...base };
  }
  const transport = readRecordedDaemonTransport(record.transport);
  return {
    state: 'running',
    stateDir: paths.baseDir,
    pid: identity.pid,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(transport ? { transport } : {}),
    plugins: record.plugins,
  };
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
