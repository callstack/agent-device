import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { readCaptureGrantId } from '@agent-device/kernel/contracts';

export { readCaptureGrantId };
import { AppError } from '@agent-device/kernel/errors';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';
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
 * #4518: the one client-owned record of where a remote capture's output belongs. A remote
 * `record start` names a local destination in `meta.clientArtifactPaths.outPath`; the daemon echoes
 * the grant ID this client minted for the attempt back when the capture finishes — usually in a
 * LATER CLI process, which keeps no memory of the start. This store is that memory: persisted
 * under the existing remote-connections state owner (ADR 0016's owner pattern) BEFORE the start is
 * dispatched, keyed by the immutable grant ID, so a response can only ever be sent to a destination
 * this client itself chose. A daemon echo is not authority; it is matched against this record by
 * the echoed ID and the full scope, never believed, and with no echo or no match only the
 * contained cwd-local name remains (disclosed) — the pre-grant behavior.
 *
 * A grant record never outlives the capture it covers: a matching stop whose delivery succeeded
 * deletes it, a successful close retires its whole scope, and the admission sweep removes anything
 * untouched for the shared `STALE_RECORD_MS` horizon. The admission caps therefore bound only
 * unresolved records.
 */

/** The capture kinds a finishing action can close: the command names the slot. */
export type CaptureSlot = 'record';

export type CaptureGrant = Readonly<{
  version: 1;
  grantId: string;
  slot: CaptureSlot;
  destination: string;
  scope: Readonly<{
    baseUrl: string;
    tenantId: string;
    runId: string;
    leaseId: string;
    session: string;
  }>;
  createdAtMs: number;
}>;

/** Finite admission: at most this many grant records per state directory (prior design choice). */
const MAX_CAPTURE_GRANTS = 64;
/** Aggregate serialized metadata limit per state directory. */
const MAX_CAPTURE_GRANT_STORE_METADATA_BYTES = 8 * 1024 * 1024;
/** One sweep scans at most this many entries, so admission stays bounded. */
const SWEEP_SCAN_LIMIT = 256;
const GRANT_LOCK_TIMEOUT_MS = 30_000;

/** The capture slot a request's command names, or `undefined` for a non-capture command. */
export function captureSlotOfCommand(command: string | undefined): CaptureSlot | undefined {
  return command === 'record' ? 'record' : undefined;
}

/**
 * Whether this request STARTS a capture whose destination a later request must still be honored
 * for. One-shot observations finish in the same request and are covered by that request's own
 * `clientArtifactPaths`; only multi-request captures need a grant.
 */
export function isCaptureStartRequest(req: Omit<DaemonWireRequest, 'token'>): boolean {
  return req.command === 'record' && (req.positionals?.[0] ?? '').toLowerCase() === 'start';
}

/** Whether this request finishes a capture an earlier request started. */
export function finishesCaptureRequest(req: Omit<DaemonWireRequest, 'token'>): boolean {
  return req.command === 'record' && (req.positionals?.[0] ?? '').toLowerCase() === 'stop';
}

/** One distinct ID per start attempt: the grant's immutable storage key. */
function mintCaptureGrantId(): string {
  return crypto.randomUUID();
}

function grantsDir(stateDir: string): string {
  return path.join(stateDir, 'remote-connections', 'capture-grants');
}

function grantScope(baseUrl: string, req: Omit<DaemonWireRequest, 'token'>): CaptureGrant['scope'] {
  const lease = leaseScopeFromRequest(req);
  return {
    baseUrl: withoutTrailingSlashes(baseUrl),
    tenantId: lease.tenantId ?? '',
    runId: lease.runId ?? '',
    leaseId: lease.leaseId ?? '',
    session: req.session ?? '',
  };
}

function scopeMatches(
  scope: CaptureGrant['scope'],
  baseUrl: string,
  req: Omit<DaemonWireRequest, 'token'>,
): boolean {
  const expected = grantScope(baseUrl, req);
  return (
    scope.baseUrl === expected.baseUrl &&
    scope.tenantId === expected.tenantId &&
    scope.runId === expected.runId &&
    scope.leaseId === expected.leaseId &&
    scope.session === expected.session
  );
}

/**
 * Persists a grant before dispatch. The store lock covers the census, eviction, and publish.
 * Missing or evicted grants never authorize a producer's later echo.
 */
export async function admitCaptureGrant(params: {
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
  slot: CaptureSlot;
  destination: string;
}): Promise<string> {
  const grantId = mintCaptureGrantId();
  const dir = grantsDir(params.stateDir);
  const file = path.join(dir, `${grantId}.json`);
  const record: CaptureGrant = {
    version: 1,
    grantId,
    slot: params.slot,
    destination: params.destination,
    scope: grantScope(params.baseUrl, params.req),
    createdAtMs: Date.now(),
  };
  const serialized = `${JSON.stringify(record)}\n`;
  const incomingBytes = Buffer.byteLength(serialized, 'utf8');
  if (incomingBytes > MAX_CAPTURE_GRANT_STORE_METADATA_BYTES) {
    throw new AppError(
      'COMMAND_FAILED',
      'The remote capture grant exceeds the store metadata size limit.',
      {
        reason: 'capture_grant_admission_refused',
        limit: MAX_CAPTURE_GRANT_STORE_METADATA_BYTES,
      },
    );
  }
  await withStoreLock(dir, async () => {
    const entries = censusGrants(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    pruneGrantsForAdmission(dir, entries, incomingBytes);
    publishFileSync({ destination: file, contents: serialized, mode: 0o600 });
  });
  return grantId;
}

/**
 * The grant a response's PRODUCER-ECHOED `captureGrantId` names, or `undefined` when no record
 * matches the ID AND this request's full scope (endpoint/tenant/run/lease/session/slot). This is
 * the ONLY way a persisted start destination is ever authorized: a missing echo (an older daemon)
 * or a nonmatching ID authorizes nothing — there is no scope-open fallback, and a generation is
 * never inferred from an unbound response. An unmatched ID authorizes nothing.
 */
export function readCaptureGrantById(params: {
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
  slot: CaptureSlot;
  grantId: string | undefined;
}): CaptureGrant | undefined {
  const grantId = readCaptureGrantId(params.grantId);
  if (grantId === undefined) return undefined;
  const record = parseGrantFile(path.join(grantsDir(params.stateDir), `${grantId}.json`));
  if (
    record === undefined ||
    record.grantId !== grantId ||
    record.slot !== params.slot ||
    !scopeMatches(record.scope, params.baseUrl, params.req)
  ) {
    return undefined;
  }
  return record;
}

/**
 * Deletes the one grant a response's PRODUCER-ECHOED `captureGrantId` matched, after the capture
 * it covers was delivered successfully — including a matching echo that carried no artifacts. Also
 * releases the grant of a start known to have failed before execution. Only a record matching the
 * ID AND this request's full scope (endpoint/tenant/run/lease/session/slot) is ever removed.
 * Never throws; an unmatched ID releases nothing.
 */
export async function releaseCaptureGrant(params: {
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
  slot: CaptureSlot;
  grantId: string | undefined;
}): Promise<void> {
  const grantId = readCaptureGrantId(params.grantId);
  if (grantId === undefined) return;
  const dir = grantsDir(params.stateDir);
  const file = path.join(dir, `${grantId}.json`);
  try {
    await withStoreLock(dir, async () => {
      const record = parseGrantFile(file);
      if (
        record === undefined ||
        record.grantId !== grantId ||
        record.slot !== params.slot ||
        !scopeMatches(record.scope, params.baseUrl, params.req)
      ) {
        return;
      }
      fs.rmSync(file, { force: true });
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'capture_grant_release_failed',
      data: { grantId, error: String(error) },
    });
  }
}

/**
 * Retires every grant record of this request's authenticated scope — the records a successful
 * `close` ends, because the close finishes or disposes the session's captures without a stop
 * echo. Only records whose full scope (endpoint/tenant/run/lease/session) matches the close are
 * removed; another scope's grants are never touched. Never throws.
 */
export async function retireCaptureGrantsInScope(params: {
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
}): Promise<void> {
  const dir = grantsDir(params.stateDir);
  try {
    await withStoreLock(dir, async () => {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch (error) {
        if (isNotFoundError(error)) return;
        throw error;
      }
      for (const name of names.slice(0, SWEEP_SCAN_LIMIT)) {
        if (!name.endsWith('.json')) continue;
        const record = parseGrantFile(path.join(dir, name));
        if (record === undefined || !scopeMatches(record.scope, params.baseUrl, params.req)) {
          continue;
        }
        fs.rmSync(path.join(dir, name), { force: true });
      }
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'capture_grant_retire_failed',
      data: { session: params.req.session, error: String(error) },
    });
  }
}

/**
 * Whether a response artifact's `localPath` is a destination this client granted for the capture
 * now finishing, and if so returns it. Only derivations of the granted destination qualify: the
 * exact path, the recording-extension-appended form a normal record producer echoes (the platform
 * extension is the only mutation it applies), the telemetry path derived from an authorized primary,
 * or a `part-NNN` chunk path derived from an authorized primary. Anything else is `undefined`, and
 * the caller falls back to a cwd-local contained name — a response string never chooses the
 * directory.
 */
export function authorizedCaptureLocalPath(params: {
  grant: CaptureGrant | undefined;
  field: string;
  localPath: unknown;
}): string | undefined {
  const { grant, field, localPath } = params;
  if (grant === undefined || typeof localPath !== 'string' || localPath.length === 0) {
    return undefined;
  }
  const primaries = primaryForms(grant.destination);
  if (field === 'outPath') {
    return primaries.includes(localPath) ? localPath : undefined;
  }
  if (field === 'telemetryPath') {
    return primaries.some((primary) => deriveRecordingTelemetryPath(primary) === localPath)
      ? localPath
      : undefined;
  }
  if (field === 'chunkPath') {
    return primaries.some((primary) => isDerivedChunkPath(primary, localPath))
      ? localPath
      : undefined;
  }
  return undefined;
}

/** Emits the one-line diagnostic for a response path no grant authorized. */
export function discloseUnauthorizedLocalPath(
  req: Omit<DaemonWireRequest, 'token'>,
  field: string,
  detail: 'missing-grant' | 'unmatched-grant-id' | 'not-a-derivation',
): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'capture_artifact_local_path_refused',
    data: { session: req.session, command: req.command, field, detail },
  });
}

/**
 * The granted destination plus the recording-extension forms a normal producer may echo. The daemon
 * appends the session platform's extension only when the registered path has none
 * (`appendRecordingExtensionWhenMissing`), so those are the only mutations of the grant a
 * legitimate echo can carry.
 */
function primaryForms(grant: string): string[] {
  if (path.extname(grant)) return [grant];
  return [
    grant,
    appendRecordingExtensionWhenMissing(grant, recordingExtensionForPlatform(undefined)),
    appendRecordingExtensionWhenMissing(grant, recordingExtensionForPlatform('web')),
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
  const extension = base.ext || '.mp4';
  if (other.ext !== extension) return false;
  const prefix = `${base.name}.part-`;
  if (!other.name.startsWith(prefix)) return false;
  return /^\d{3,}$/.test(other.name.slice(prefix.length));
}

type GrantCensusEntry = Readonly<{ name: string; sizeBytes: number; mtimeMs: number }>;

function pruneGrantsForAdmission(
  dir: string,
  entries: GrantCensusEntry[],
  incomingBytes: number,
): void {
  const staleBefore = Date.now() - STALE_RECORD_MS;
  let count = entries.length;
  let bytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (
      entry.mtimeMs >= staleBefore &&
      count < MAX_CAPTURE_GRANTS &&
      bytes + incomingBytes <= MAX_CAPTURE_GRANT_STORE_METADATA_BYTES
    ) {
      break;
    }
    fs.rmSync(path.join(dir, entry.name), { force: true });
    count -= 1;
    bytes -= entry.sizeBytes;
  }
}

/** Admission must know every record's size and age before it can make room. */
function censusGrants(dir: string): GrantCensusEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw uncertainCensusError(dir, error);
  }
  const entries: GrantCensusEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const { size, mtimeMs } = fs.statSync(path.join(dir, name));
      entries.push({ name, sizeBytes: size, mtimeMs });
    } catch (error) {
      throw uncertainCensusError(dir, error);
    }
  }
  return entries;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function uncertainCensusError(dir: string, cause: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The remote capture grant store cannot be read; admission is refused while the census is uncertain.',
    {
      reason: 'capture_grant_census_uncertain',
      dir,
      hint: 'Restore read access to remote-connections/capture-grants in the agent-device state directory.',
    },
    cause,
  );
}

function parseGrantFile(file: string): CaptureGrant | undefined {
  let contents: string | undefined;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return asCaptureGrant(JSON.parse(contents));
  } catch {
    return undefined;
  }
}

/** A record that does not parse in FULL authorizes nothing: no half-shaped field is repaired. */
function asCaptureGrant(value: unknown): CaptureGrant | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<CaptureGrant>;
  if (record.version !== 1) return undefined;
  if (readCaptureGrantId(record.grantId) !== record.grantId) return undefined;
  if (record.slot !== 'record') return undefined;
  if (typeof record.destination !== 'string' || record.destination.length === 0) return undefined;
  if (!isGrantScope(record.scope)) return undefined;
  if (!isFiniteMs(record.createdAtMs)) return undefined;
  return record as CaptureGrant;
}

function isGrantScope(scope: unknown): scope is CaptureGrant['scope'] {
  if (typeof scope !== 'object' || scope === null) return false;
  const value = scope as Record<string, unknown>;
  return ['baseUrl', 'tenantId', 'runId', 'leaseId', 'session'].every(
    (field) => typeof value[field] === 'string',
  );
}

function isFiniteMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

async function withStoreLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  return await withRemoteStateLock(
    {
      lockDirPath: `${dir}.lock`,
      description: 'remote capture grant store',
      timeoutMs: GRANT_LOCK_TIMEOUT_MS,
    },
    task,
  );
}
