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
import { withoutTrailingSlashes, withRemoteStateLock } from './remote-state-record-lock.ts';

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
 */

/** The capture kinds a finishing action can close: the command names the slot. */
export type CaptureSlot = 'record';

/** The lifecycle of one grant record. `pending-recovery` records are never swept. */
export type CaptureGrantState = 'open' | 'finished' | 'pending-recovery';

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
  state: CaptureGrantState;
  createdAtMs: number;
  updatedAtMs: number;
}>;

/** Finite admission: at most this many grant records per state directory (prior design choice). */
const MAX_CAPTURE_GRANTS = 64;
/**
 * Finite admission, aggregate: the serialized metadata of ALL grant records in one state
 * directory may not exceed this TOTAL. Admission reserves room for the incoming record — the
 * store is refused once existing bytes plus the new record would pass the cap, so the budget is
 * never exceeded and there is always headroom for growth up to it. (prior design choice)
 */
const MAX_CAPTURE_GRANT_STORE_METADATA_BYTES = 8 * 1024 * 1024;
/**
 * A KNOWN-FINISHED record untouched for this long is expired by the sweep. Open and
 * pending-recovery records are retained evidence and are never swept, however old.
 */
const STALE_CAPTURE_GRANT_MS = 7 * 24 * 60 * 60 * 1000;
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
 * Admits one capture-start grant and durably stores it BEFORE the request is dispatched: the
 * bounded sweep and the aggregate census run under one state admission lock, and the record is
 * written by its immutable grant ID — never as a latest-slot overwrite. The aggregate admission
 * is finite: at most `MAX_CAPTURE_GRANTS` records and `MAX_CAPTURE_GRANT_STORE_METADATA_BYTES` of
 * TOTAL serialized metadata, reserving room for the incoming record within that budget. An
 * UNCERTAIN census (the store directory exists but cannot be read or sized) refuses admission
 * rather than counting as zero — fail-closed. Refuses (throws) when the record cannot be
 * admitted or written, so a destination the client cannot remember must not become writable
 * later from a response echo. Returns the minted grant ID the request should carry in
 * `meta.captureGrantId`.
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
  const now = Date.now();
  const record: CaptureGrant = {
    version: 1,
    grantId,
    slot: params.slot,
    destination: params.destination,
    scope: grantScope(params.baseUrl, params.req),
    state: 'open',
    createdAtMs: now,
    updatedAtMs: now,
  };
  const serialized = `${JSON.stringify(record)}\n`;
  const incomingBytes = Buffer.byteLength(serialized, 'utf8');
  await withStoreLock(dir, async () => {
    const before = censusGrants(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    sweepGrants(dir, before.entries);
    const census = censusGrants(dir);
    if (census.count >= MAX_CAPTURE_GRANTS) {
      throw new AppError('COMMAND_FAILED', 'Too many retained remote capture grants.', {
        reason: 'capture_grant_admission_refused',
        limit: MAX_CAPTURE_GRANTS,
        hint: 'Finish or close the open captures, or clear stale records under remote-connections/capture-grants in the agent-device state directory.',
      });
    }
    if (census.bytes + incomingBytes > MAX_CAPTURE_GRANT_STORE_METADATA_BYTES) {
      throw new AppError(
        'COMMAND_FAILED',
        'The retained remote capture grant metadata exceeds the aggregate size limit.',
        {
          reason: 'capture_grant_admission_refused',
          limit: MAX_CAPTURE_GRANT_STORE_METADATA_BYTES,
          hint: 'Finish or close the open captures, or clear stale records under remote-connections/capture-grants in the agent-device state directory.',
        },
      );
    }
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
 * Every KNOWN-OPEN grant record of this scope and slot, newest first. Used when a finishing
 * answer leaves the capture's outcome uncertain: ALL of the scope's open grants become
 * pending-recovery — never one guessed grant, because an unbound response cannot say which
 * start it covered. A response string never chooses a grant on its own; only the client's own
 * persisted records are listed here.
 */
export function listOpenCaptureGrantsInScope(params: {
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
  slot: CaptureSlot;
}): CaptureGrant[] {
  const dir = grantsDir(params.stateDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const open: CaptureGrant[] = [];
  for (const name of entries.slice(0, SWEEP_SCAN_LIMIT)) {
    if (!name.endsWith('.json')) continue;
    const record = parseGrantFile(path.join(dir, name));
    if (
      record === undefined ||
      record.slot !== params.slot ||
      record.state !== 'open' ||
      !scopeMatches(record.scope, params.baseUrl, params.req)
    ) {
      continue;
    }
    open.push(record);
  }
  return open.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

/**
 * Settles a grant after the capture it covers reached a known outcome: `finished` when a matching
 * stop/report answered, `pending-recovery` when the finishing answer was uncertain. A
 * `pending-recovery` record is never swept. Never throws; an unmatched ID settles nothing.
 */
export async function settleCaptureGrant(params: {
  stateDir: string;
  baseUrl: string;
  req: Omit<DaemonWireRequest, 'token'>;
  slot: CaptureSlot;
  grantId: string | undefined;
  outcome: 'finished' | 'pending-recovery';
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
      const settled: CaptureGrant = {
        ...record,
        state: params.outcome,
        updatedAtMs: Date.now(),
      };
      publishFileSync({
        destination: file,
        contents: `${JSON.stringify(settled)}\n`,
        mode: 0o600,
      });
    });
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'capture_grant_settle_failed',
      data: { grantId, outcome: params.outcome, error: String(error) },
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

/**
 * Bounded sweep: removes ONLY expired records whose state is KNOWN-FINISHED. Retained known-open
 * and pending-recovery evidence is preserved even when old; a record nobody can parse is
 * uncertain evidence and stays (it still counts toward the admission caps, fail-closed). Runs
 * under the admission lock, so it never interleaves with another process's census or write.
 */
function sweepGrants(dir: string, entries: readonly GrantCensusEntry[]): void {
  const staleBefore = Date.now() - STALE_CAPTURE_GRANT_MS;
  for (const entry of entries.slice(0, SWEEP_SCAN_LIMIT)) {
    const record = parseGrantFile(path.join(dir, entry.name));
    if (record === undefined) continue;
    if (record.state !== 'finished') continue;
    if (record.updatedAtMs >= staleBefore) continue;
    fs.rmSync(path.join(dir, entry.name), { force: true });
  }
}

type GrantCensusEntry = Readonly<{ name: string; sizeBytes: number }>;

type GrantCensus = Readonly<{
  count: number;
  bytes: number;
  entries: GrantCensusEntry[];
}>;

/**
 * The admission census: how many grant records the store holds and how many bytes of serialized
 * metadata they total. A missing store directory is an EMPTY census (certain), never an error.
 * Anything else unreadable — a path that is not a directory, a record that cannot be sized — is
 * an UNCERTAIN census and throws, so admission is denied instead of counting the unknown as zero.
 */
function censusGrants(dir: string): GrantCensus {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (isNotFoundError(error)) return { count: 0, bytes: 0, entries: [] };
    throw uncertainCensusError(dir, error);
  }
  let count = 0;
  let bytes = 0;
  const entries: GrantCensusEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let sizeBytes: number;
    try {
      sizeBytes = fs.statSync(path.join(dir, name)).size;
    } catch (error) {
      throw uncertainCensusError(dir, error);
    }
    count += 1;
    bytes += sizeBytes;
    entries.push({ name, sizeBytes });
  }
  return { count, bytes, entries };
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
  if (!isGrantState(record.state)) return undefined;
  if (!isFiniteMs(record.createdAtMs) || !isFiniteMs(record.updatedAtMs)) return undefined;
  return record as CaptureGrant;
}

function isGrantScope(scope: unknown): scope is CaptureGrant['scope'] {
  if (typeof scope !== 'object' || scope === null) return false;
  const value = scope as Record<string, unknown>;
  return ['baseUrl', 'tenantId', 'runId', 'leaseId', 'session'].every(
    (field) => typeof value[field] === 'string',
  );
}

function isGrantState(state: unknown): state is CaptureGrantState {
  return state === 'open' || state === 'finished' || state === 'pending-recovery';
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
