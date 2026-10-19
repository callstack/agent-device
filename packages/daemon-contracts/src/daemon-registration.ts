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
  readDaemonOwnership,
  readDaemonRecord,
  readRecordedDaemonTransport,
  resolveDaemonPaths,
  type DaemonOwnership,
  type DaemonPaths,
  type DaemonServerMode,
  type ObservedDaemonIdentity,
} from './daemon-resolution.ts';

/**
 * The daemon identity published in a state dir's `daemon.json`. It is the only
 * answer to "which process serves this state dir": clients discover a daemon
 * through this record, so a process that is not named here receives no request
 * however alive it is.
 */
export function readRegisteredDaemonIdentity(infoPath: string): OwnerIdentity | null {
  const reading = readDaemonRegistration(infoPath);
  return reading.status === 'present' ? reading.identity : null;
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
 * The one read of `daemon.json` behind every projection of that record in this module. `identity` is
 * null for a record that names no process, and `ownership` is what the record states, read the way a
 * reader must read it before anything is signaled.
 */
type DaemonRegistrationReading =
  | Readonly<{
      status: 'present';
      record: DaemonRecord;
      identity: OwnerIdentity | null;
      ownership: DaemonOwnership;
    }>
  | Readonly<{ status: 'absent' | 'unreadable' | 'invalid' }>;

function readDaemonRegistration(infoPath: string): DaemonRegistrationReading {
  const read = readDaemonRecord(infoPath);
  if (read.status !== 'present') return { status: read.status };
  const parsed = parseRegistration(read.record);
  return {
    status: 'present',
    record: read.record,
    identity: parsed.pid === null ? null : { pid: parsed.pid, startTime: parsed.startTime },
    ownership: readDaemonOwnership(read.record.ownership),
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
  const reading = readDaemonRegistration(infoPath);
  if (reading.status !== 'present')
    return { state: reading.status === 'invalid' ? 'ownerless' : reading.status };
  // A record that names no process describes nothing a caller can own, however it came to that.
  if (!reading.identity) return { state: 'ownerless' };
  if (!owner) return { state: 'unproven' };
  if (ownerIdentityDiffers(reading.identity, owner)) {
    return { state: 'replaced', identity: reading.identity };
  }
  // Two missing start times agree, and agreeing on nothing is not ownership: this is the pid-only
  // fallback the fence exists to refuse, so it falls to `unproven` rather than to `match`.
  if (ownerIdentityMatches(reading.identity, owner) && reading.identity.startTime !== null) {
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
   * Who owns the process this record names, and so who may end it. Only a running record can say: a
   * stopped one names no live process to own.
   */
  ownership?: DaemonOwnership;
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
  const reading = readDaemonRegistration(paths.infoPath);
  if (reading.status !== 'present') {
    return reading.status === 'absent'
      ? { state: 'stopped', ...base }
      : { state: reading.status, ...base };
  }
  const { record } = reading;
  if (reading.identity === null) return { state: 'stopped', ...base };
  const identity = reading.identity;
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
    ownership: reading.ownership,
    ...(typeof record.version === 'string' ? { version: record.version } : {}),
    ...(transport ? { transport } : {}),
    plugins: record.plugins,
  };
}

function readableStartTime(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * What one read of `daemon.json` proves about the process it names, and the one observation every stop
 * route judges. The lifetime and the owner come from the same read on purpose: a stop that routed on one
 * record and retired on another could signal a process the record it acted on did not name.
 *
 * `identity` is null for a readable record that names no process, which leaves nothing to signal.
 * `absent` is no record at all, so nothing claims the state directory. `unreadable` is a record that is
 * present and cannot be read or parsed: it may describe a runtime that is serving, so a stop refuses it
 * rather than reporting that nothing runs.
 */
export type DaemonStopIdentity = Readonly<{
  /** `absent`: no record. `unreadable`: a record whose contents cannot be used, unreadable or malformed. */
  ownership: DaemonOwnership | 'absent' | 'unreadable';
  identity: OwnerIdentity | null;
}>;

/**
 * Reads a state directory's record once for a stop: whether it names a process, and whose process that
 * is. A record that states no owner describes the pre-existing detached daemon, which is what every
 * record written before the ownership field named.
 */
export function readDaemonStopIdentity(infoPath: string): DaemonStopIdentity {
  const reading = readDaemonRegistration(infoPath);
  if (reading.status !== 'present')
    return { ownership: reading.status === 'absent' ? 'absent' : 'unreadable', identity: null };
  return { ownership: reading.ownership, identity: reading.identity };
}

/**
 * The observation a retirement judges, from a stop's read of the record. `absent` names no process at
 * all, and `unreadable` describes one this read cannot use, so neither travels as an owner; the stop
 * route refuses the unreadable record before it gets here.
 */
export function observedDaemonIdentityOfRegistration(
  record: DaemonStopIdentity,
): ObservedDaemonIdentity | null {
  if (!record.identity || record.ownership === 'absent' || record.ownership === 'unreadable')
    return null;
  return { ...record.identity, ownership: record.ownership };
}

/**
 * The lifetime a `--clean` cleanup may walk, from the read that routed the stop. Only a record proving
 * the process is a daemon of its own names one, and the cleanup needs a start time to tell that lifetime
 * from whatever holds its pid now.
 */
export function readStopCleanupOwner(
  record: DaemonStopIdentity,
): { pid: number; processStartTime: string } | null {
  if (record.ownership !== 'detached' || !record.identity?.startTime) return null;
  return { pid: record.identity.pid, processStartTime: record.identity.startTime };
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
