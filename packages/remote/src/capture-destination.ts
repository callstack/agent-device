import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';
import { AppError } from '@agent-device/kernel/errors';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from '@agent-device/capture-kit/recording-output-path';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { publishFileSync } from '@agent-device/host-kit/file';
import {
  STALE_RECORD_MS,
  withoutTrailingSlashes,
  withRemoteStateLock,
} from './remote-state-record-lock.ts';

/**
 * #4518: the destinations this client named in remote `record start` requests. A `record stop`
 * usually runs in a later CLI process, so the client saves each destination before it dispatches
 * the start, keyed by scope (endpoint, tenant, run, lease, session). A stop accepts a daemon
 * `localPath` only when it derives from a destination saved for the same scope. The daemon can
 * therefore choose only among paths this client already chose. A record retires on a delivered
 * stop that used it, on a confirmed close of its scope, or after `STALE_RECORD_MS`.
 */

type SavedDestination = Readonly<{ destination: string; createdAtMs: number }>;

/** A real path is much shorter. A scope file therefore stays below 1 MiB. */
const MAX_DESTINATION_BYTES = 64 * 1024;
/** A full scope evicts its oldest record, so a session cannot lock itself out. */
const MAX_DESTINATIONS_PER_SCOPE = 16;
const STORE_LOCK_TIMEOUT_MS = 30_000;

type ScopeParams = Readonly<{
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
}>;

function storeDir(stateDir: string): string {
  return path.join(stateDir, 'remote-connections', 'capture-destinations');
}

function scopeFile({ stateDir, baseUrl, req }: ScopeParams): string {
  const lease = leaseScopeFromRequest(req);
  const scope = [
    withoutTrailingSlashes(baseUrl),
    lease.tenantId ?? '',
    lease.runId ?? '',
    lease.leaseId ?? '',
    req.session ?? '',
  ];
  const key = crypto.createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  return path.join(storeDir(stateDir), `${key}.json`);
}

/** Saves a start destination before dispatch. Also removes stale scope files. */
export async function saveCaptureDestination(
  params: ScopeParams & { destination: string },
): Promise<void> {
  if (Buffer.byteLength(params.destination, 'utf8') > MAX_DESTINATION_BYTES) {
    throw new AppError('INVALID_ARGS', 'The remote recording destination path is too long.', {
      reason: 'capture_destination_too_large',
      limit: MAX_DESTINATION_BYTES,
    });
  }
  const dir = storeDir(params.stateDir);
  const file = scopeFile(params);
  await withStoreLock(dir, async () => {
    const now = Date.now();
    removeStaleScopeFiles(dir, now);
    const kept = freshDestinations(readScopeFile(file), now).slice(
      -(MAX_DESTINATIONS_PER_SCOPE - 1),
    );
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeScopeFile(file, [...kept, { destination: params.destination, createdAtMs: now }]);
  });
}

/** The fresh destinations saved for this request's scope, newest last. */
export function readCaptureDestinations(params: ScopeParams): string[] {
  return freshDestinations(readScopeFile(scopeFile(params)), Date.now()).map(
    (record) => record.destination,
  );
}

/**
 * Removes saved destinations of this request's scope: the given ones after a delivered stop, or
 * all of them after a confirmed close. Never throws.
 */
export async function retireCaptureDestinations(
  params: ScopeParams & { only?: ReadonlySet<string> },
): Promise<void> {
  const file = scopeFile(params);
  const only = params.only;
  try {
    await withStoreLock(storeDir(params.stateDir), async () => {
      const kept = only
        ? readScopeFile(file).filter((record) => !only.has(record.destination))
        : [];
      if (kept.length > 0) writeScopeFile(file, kept);
      else fs.rmSync(file, { force: true });
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'capture_destination_retire_failed',
      data: { session: params.req.session, error: String(error) },
    });
  }
}

/**
 * The saved destination that a response artifact's `localPath` derives from, or `undefined`.
 * Only these derivations qualify: the exact path, the path with the recording extension that the
 * producer appends when the path has none, the telemetry path of that primary, and a `part-NNN`
 * chunk path of that primary.
 */
export function matchCaptureDestination(
  destinations: readonly string[],
  field: string,
  localPath: unknown,
): string | undefined {
  if (typeof localPath !== 'string' || localPath.length === 0) return undefined;
  const derives = (primary: string): boolean => {
    if (field === 'outPath') return primary === localPath;
    if (field === 'telemetryPath') return deriveRecordingTelemetryPath(primary) === localPath;
    if (field === 'chunkPath') return isDerivedChunkPath(primary, localPath);
    return false;
  };
  return [...destinations].reverse().find((destination) => primaryForms(destination).some(derives));
}

/** Emits the one-line diagnostic for a response path that no saved destination authorized. */
export function discloseUnauthorizedLocalPath(
  req: Omit<DaemonWireRequest, 'token'>,
  field: string,
  detail: 'no-saved-destination' | 'not-a-derivation',
): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'capture_artifact_local_path_refused',
    data: { session: req.session, command: req.command, field, detail },
  });
}

/**
 * The saved destination plus the recording-extension forms a normal producer may echo. The daemon
 * appends the session platform's extension only when the registered path has none
 * (`appendRecordingExtensionWhenMissing`).
 */
function primaryForms(destination: string): string[] {
  if (path.extname(destination)) return [destination];
  return [
    destination,
    appendRecordingExtensionWhenMissing(destination, recordingExtensionForPlatform(undefined)),
    appendRecordingExtensionWhenMissing(destination, recordingExtensionForPlatform('web')),
  ];
}

/**
 * The `part-NNN` sibling rule a recording's later chunks follow from their base path: same
 * directory, `${name}.part-` plus at least three digits, same extension (`.mp4` when the base has
 * none).
 */
function isDerivedChunkPath(primary: string, candidate: string): boolean {
  const base = path.parse(primary);
  const other = path.parse(candidate);
  if (other.dir !== base.dir) return false;
  if (other.ext !== (base.ext || '.mp4')) return false;
  const prefix = `${base.name}.part-`;
  return other.name.startsWith(prefix) && /^\d{3,}$/.test(other.name.slice(prefix.length));
}

function freshDestinations(records: SavedDestination[], now: number): SavedDestination[] {
  return records.filter((record) => record.createdAtMs >= now - STALE_RECORD_MS);
}

function removeStaleScopeFiles(dir: string, now: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < now - STALE_RECORD_MS) fs.rmSync(file, { force: true });
    } catch {
      // Another process removed it.
    }
  }
}

/** A malformed file or record authorizes nothing. */
function readScopeFile(file: string): SavedDestination[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) return [];
    return value.filter(
      (record): record is SavedDestination =>
        typeof record?.destination === 'string' &&
        record.destination.length > 0 &&
        Number.isFinite(record.createdAtMs),
    );
  } catch {
    return [];
  }
}

function writeScopeFile(file: string, records: SavedDestination[]): void {
  publishFileSync({ destination: file, contents: `${JSON.stringify(records)}\n`, mode: 0o600 });
}

async function withStoreLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  return await withRemoteStateLock(
    {
      lockDirPath: `${dir}.lock`,
      description: 'remote capture destination store',
      timeoutMs: STORE_LOCK_TIMEOUT_MS,
    },
    task,
  );
}
