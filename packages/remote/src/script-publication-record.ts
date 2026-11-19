import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { acquireProcessLock, publishFileSync, withProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';

/** A record untouched for this long is removed the next time a record is created. */
const STALE_RECORD_MS = 7 * 24 * 60 * 60 * 1000;

const RECORD_LOCK_TIMEOUT_MS = 30_000;

/**
 * This client's record of one remote `open --save-script`, keyed by the endpoint, tenant, session
 * and the publication ID this client minted for that open. Only this client creates records, so a
 * daemon response never establishes a destination. `revision` is the newest version published.
 * `publishing` names a version, the staged file's identity, and its staging directory before the
 * rename, so a crash between the rename and the revision update is settled from the destination's
 * identity, and the staging directory is removed once nothing can name it. `staging` lists every
 * staging directory allocated and not yet removed, so retiring or sweeping the record reclaims the
 * ones a crashed download left behind. `retired` marks a record a close has ended: it authorizes no
 * further version and stays on disk only until its staging directories are removed.
 */
export type ScriptRecord = Readonly<{
  destination: string;
  force: boolean;
  revision: number;
  publishing?: Readonly<{ revision: number; file: string; staging: string }>;
  staging?: readonly string[];
  retired?: true;
}>;

export function recordPath(
  stateDir: string,
  baseUrl: string,
  req: DaemonWireRequest,
  publicationId: string,
): string {
  const key = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        withoutTrailingSlashes(baseUrl),
        req.meta?.tenantId ?? '',
        req.session ?? '',
        publicationId,
      ]),
    )
    .digest('hex');
  return path.join(stateDir, 'remote-connections', 'session-scripts', `${key}.json`);
}

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/**
 * Creates a record, and removes the records a close retired and those nobody has touched for
 * `STALE_RECORD_MS`.
 */
export async function createRecord(file: string, record: ScriptRecord): Promise<void> {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const isStale = (entry: string) =>
    (fs.lstatSync(entry, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) <
    Date.now() - STALE_RECORD_MS;
  const sweepable = (entry: string) => isStale(entry) || parseRecord(entry)?.retired === true;
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    if (!name.endsWith('.json') || !sweepable(entry)) continue;
    // Rechecked under the lock, so a record that a publish just refreshed stays. A record that
    // cannot be swept now is retried by a later sweep and never blocks this open.
    await withRecordLock(entry, async () => {
      if (sweepable(entry)) removeRecord(entry);
    }).catch((error: unknown) =>
      emitDiagnostic({
        level: 'warn',
        phase: 'session_script_sweep_failed',
        data: { record: name, error: String(error) },
      }),
    );
  }
  writeRecord(file, record);
}

/** A record that does not parse, or that a close has retired, authorizes nothing. */
export function readRecord(file: string): ScriptRecord | undefined {
  const record = parseRecord(file);
  return record?.retired ? undefined : record;
}

function parseRecord(file: string): ScriptRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const record = parsed as Partial<Record<keyof ScriptRecord, unknown>>;
  const valid =
    typeof record.destination === 'string' &&
    typeof record.force === 'boolean' &&
    Number.isSafeInteger(record.revision) &&
    (record.publishing === undefined || isPublishing(record.publishing)) &&
    (record.retired === undefined || record.retired === true) &&
    (record.staging === undefined ||
      (Array.isArray(record.staging) &&
        record.staging.every((staging) => typeof staging === 'string')));
  if (!valid) return undefined;
  // A digest an earlier version of this client kept is dropped, so the next write does not carry it forward.
  const {
    committedDigest: _digest,
    entry: _entry,
    ...current
  } = record as ScriptRecord & { committedDigest?: unknown; entry?: unknown };
  return current;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublishing(publishing: unknown): boolean {
  return (
    isObject(publishing) &&
    Number.isSafeInteger(publishing.revision) &&
    typeof publishing.file === 'string' &&
    typeof publishing.staging === 'string'
  );
}

export function writeRecord(file: string, record: ScriptRecord): void {
  publishFileSync({ destination: file, contents: `${JSON.stringify(record)}\n`, mode: 0o600 });
}

export async function withRecordLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  const { pid, startTime } = readCurrentOwnerIdentity();
  return await withProcessLock({
    acquire: () =>
      acquireProcessLock({
        lockDirPath: `${file}.lock`,
        owner: { pid, startTime, acquiredAtMs: Date.now() },
        timeoutMs: RECORD_LOCK_TIMEOUT_MS,
        description: 'remote session script record',
      }),
    task,
  });
}

/**
 * Ends a record, then removes every staging directory it lists and the record itself. The record is
 * first written retired, so it authorizes nothing more even when a staging directory cannot be
 * removed; the sweep finishes the cleanup later. Writing it retired also stops it naming an
 * interrupted version, so no anchor is removed while the record names its inode. A record that
 * cannot be written retired is removed at once. Only a state directory that allows neither write
 * leaves the record active; the close logs that failure and keeps its own outcome.
 */
export function removeRecord(file: string): void {
  const record = parseRecord(file);
  if (record && !record.retired) {
    try {
      writeRecord(file, { ...withoutPublishing(record), retired: true });
    } catch (error) {
      removeUnretirableRecord(file, record);
      throw error;
    }
  }
  for (const staging of record?.staging ?? []) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.rmSync(file, { force: true });
}

/**
 * Removes a record that could not be written retired, then its staging. A record still on disk may
 * name the anchor in its interrupted version's staging, so that directory stays with it.
 */
function removeUnretirableRecord(file: string, record: ScriptRecord): void {
  const kept = removeQuietly(file) ? undefined : record.publishing?.staging;
  for (const staging of record.staging ?? []) {
    if (staging !== kept) removeQuietly(staging);
  }
}

/**
 * One removal attempt for a record that could not be written retired, and for the staging it listed.
 * A failure here never replaces the error that made the record unwritable. Reports whether the
 * target is gone.
 */
function removeQuietly(target: string): boolean {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_record_cleanup_failed',
      data: { target, error: String(error) },
    });
    return false;
  }
}

export function withoutStaging(record: ScriptRecord, staging: string): ScriptRecord {
  return { ...record, staging: (record.staging ?? []).filter((listed) => listed !== staging) };
}

export function withoutPublishing(record: ScriptRecord): ScriptRecord {
  const { publishing: _interrupted, ...rest } = record;
  return rest;
}
