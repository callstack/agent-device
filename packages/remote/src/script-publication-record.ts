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
 */
export type ScriptRecord = Readonly<{
  destination: string;
  force: boolean;
  revision: number;
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

/** Creates a record, and removes the records nobody has touched for `STALE_RECORD_MS`. */
export async function createRecord(file: string, record: ScriptRecord): Promise<void> {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const isStale = (entry: string) =>
    (fs.lstatSync(entry, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) <
    Date.now() - STALE_RECORD_MS;
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    if (!name.endsWith('.json') || !isStale(entry)) continue;
    // Rechecked under the lock, so a record that a publish just refreshed stays. A record that
    // cannot be swept now is retried by a later sweep and never blocks this open.
    await withRecordLock(entry, async () => {
      if (isStale(entry)) removeRecord(entry);
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

/** A record that does not parse authorizes nothing. Fields an earlier client kept are ignored. */
export function readRecord(file: string): ScriptRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { destination, force, revision } = parsed as Partial<Record<keyof ScriptRecord, unknown>>;
  return typeof destination === 'string' &&
    typeof force === 'boolean' &&
    Number.isSafeInteger(revision)
    ? { destination, force, revision: revision as number }
    : undefined;
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

export function removeRecord(file: string): void {
  fs.rmSync(file, { force: true });
}
