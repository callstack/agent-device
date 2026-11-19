import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { normalizeBatchCommandName } from '@agent-device/contracts/input-validation';
import { leaseScopeFromRequest } from '@agent-device/contracts/lease-scope';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DaemonError } from '@agent-device/kernel/errors';
import { AppError } from '@agent-device/kernel/errors';
import {
  appendRecordingExtensionWhenMissing,
  recordingExtensionForPlatform,
} from '@agent-device/capture-kit/recording-output-path';
import { deriveRecordingTelemetryPath } from '@agent-device/capture-kit/recording-telemetry';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { openVerifiedFileForRead, publishFileSync } from '@agent-device/host-kit/file';
import {
  STALE_RECORD_MS,
  withoutTrailingSlashes,
  withRemoteStateLock,
} from './remote-state-record-lock.ts';

/**
 * #4518: the one owner of remote recording grants. A grant is a destination this client named in a
 * remote `record start`, saved under a client-generated ID before dispatch and keyed by scope
 * (endpoint, tenant, run, lease, session). The ID never crosses the wire.
 *
 * Every remote `record start`, `record stop`, `close` and batch with a `close` step is bound to the
 * store before dispatch, and then settled from the daemon's outcome by grant ID:
 * - A start saves a pending grant. A confirmed start accepts it. A daemon refusal drops it.
 * - A stop or close binds the grants present at dispatch. A confirmed outcome retires exactly those.
 * - An unknown outcome (no daemon answer) keeps the grants. Age and the per-scope bound remove them.
 * A stop accepts a daemon `localPath` only when it derives from a bound grant. A store that cannot
 * be used degrades the request: the request proceeds, and the response carries a typed warning.
 */

type Grant = Readonly<{ id: string; destination: string; createdAtMs: number; accepted: boolean }>;

/** A real path is much shorter. With the per-scope bound, a scope file stays near 1 MiB. */
const MAX_DESTINATION_BYTES = 64 * 1024;
/** A full scope evicts pending grants first, so a refused start cannot evict a live grant. */
const MAX_GRANTS_PER_SCOPE = 16;
const MAX_SCOPE_FILE_BYTES = MAX_GRANTS_PER_SCOPE * (MAX_DESTINATION_BYTES + 512);
const GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STORE_LOCK_TIMEOUT_MS = 30_000;

export type RecordingDestinationWarning = Readonly<{
  reason:
    | 'capture_destination_store_unavailable'
    | 'capture_destination_not_saved'
    | 'capture_destination_not_derived'
    | 'capture_destination_missing';
  field?: string;
  path?: string;
}>;

/** The settlement outcome of one bound request, read from the daemon's answer. */
export type CaptureOutcome =
  | Extract<DaemonResponse, { ok: true }>
  | { ok: false; error: DaemonError };

/** One request bound to the grant store before dispatch. */
export type CaptureBinding = Readonly<{
  /** The response `localPath` a bound grant authorizes, or `undefined` after a warning. */
  authorize(field: string, localPath: unknown): string | undefined;
  /** Records the typed warning for an artifact that lands in the current directory. */
  warnFallback(field: string, localPath: unknown, fallbackPath: string): void;
  /** Settles the bound grants from the daemon's answer. Never throws. */
  settle(outcome: CaptureOutcome): Promise<void>;
  /** The response with this request's typed warnings added. */
  disclose(response: DaemonResponse): DaemonResponse;
}>;

type Scope = Readonly<{ dir: string; file: string; req: Omit<DaemonWireRequest, 'token'> }>;

/** Binds a remote recording-lifecycle request before dispatch, or `undefined` for other requests. */
export async function bindCaptureRequest(params: {
  stateDir: string;
  baseUrl: string;
  req: DaemonWireRequest;
}): Promise<CaptureBinding | undefined> {
  const { req } = params;
  const action = req.command === 'record' ? req.positionals?.[0]?.toLowerCase() : undefined;
  const closes = req.command === 'close' || batchCloses(req);
  if (action !== 'start' && action !== 'stop' && !closes) return undefined;
  const scope = scopeOf(params);
  const warnings: RecordingDestinationWarning[] = [];
  if (action === 'start') {
    const destination = req.meta?.clientArtifactPaths?.outPath;
    if (typeof destination !== 'string' || destination.length === 0) return undefined;
    const id = await storeStep(warnings, () => saveGrant(scope, destination));
    return binding(scope, [], warnings, async (outcome) => {
      if (id === undefined) return;
      if (outcome.ok) {
        await updateGrants(scope, (grants) =>
          grants.map((grant) => (grant.id === id ? { ...grant, accepted: true } : grant)),
        );
      } else await updateGrants(scope, (grants) => grants.filter((grant) => grant.id !== id));
    });
  }
  // A close reads the store only to settle it, so its own response carries no store warning.
  const stopWarnings = action === 'stop' ? warnings : [];
  const bound = (await storeStep(stopWarnings, async () => readGrants(scope))) ?? [];
  return binding(scope, action === 'stop' ? bound : [], stopWarnings, async (outcome) => {
    if (!finishesBoundGrants(req, outcome)) return;
    const ids = new Set(bound.map((grant) => grant.id));
    if (ids.size > 0) await updateGrants(scope, (grants) => grants.filter((g) => !ids.has(g.id)));
  });
}

function binding(
  scope: Scope,
  grants: readonly Grant[],
  warnings: RecordingDestinationWarning[],
  settleGrants: (outcome: CaptureOutcome) => Promise<void>,
): CaptureBinding {
  const unavailable = warnings.length > 0;
  return {
    authorize: (field, localPath) => {
      const grant = grants.find((candidate) => derives(candidate.destination, field, localPath));
      return grant === undefined ? undefined : (localPath as string);
    },
    warnFallback: (field, localPath, fallbackPath) => {
      const reason = unavailable
        ? 'capture_destination_store_unavailable'
        : grants.length === 0
          ? 'capture_destination_not_saved'
          : typeof localPath === 'string' && localPath.length > 0
            ? 'capture_destination_not_derived'
            : 'capture_destination_missing';
      warnings.push({ reason, field, path: fallbackPath });
    },
    settle: async (outcome) => {
      try {
        await settleGrants(outcome);
      } catch (error) {
        emitDiagnostic({
          level: 'warn',
          phase: 'capture_destination_settle_failed',
          data: { session: scope.req.session, error: String(error) },
        });
      }
    },
    disclose: (response) => {
      if (!response.ok || warnings.length === 0) return response;
      const data = response.data ?? {};
      const previous = Array.isArray(data.warnings) ? data.warnings : [];
      return {
        ...response,
        data: {
          ...data,
          recordingDestinationWarnings: [...warnings],
          warnings: [...previous, ...warnings.map(warningText)],
        },
      };
    },
  };
}

function warningText({ reason, field, path: saved }: RecordingDestinationWarning): string {
  return saved === undefined
    ? `The recording destination could not be saved, so record stop downloads to the current directory (${reason}).`
    : `The recording ${field} was saved to ${saved} in the current directory (${reason}).`;
}

/** Whether the daemon's answer proves that the bound grants' recordings are finished. */
function finishesBoundGrants(req: DaemonWireRequest, outcome: CaptureOutcome): boolean {
  if (req.command !== 'batch') return outcome.ok || outcome.error.code === 'SESSION_NOT_FOUND';
  const results = outcome.ok ? outcome.data?.results : outcome.error.details?.partialResults;
  return (
    Array.isArray(results) &&
    results.some(
      (result) =>
        normalizeBatchCommandName((result as { command?: unknown } | null)?.command) === 'close',
    )
  );
}

function batchCloses(req: DaemonWireRequest): boolean {
  if (req.command !== 'batch') return false;
  const steps = req.flags?.batchSteps;
  return (
    Array.isArray(steps) &&
    steps.some((step) => normalizeBatchCommandName(step?.command) === 'close')
  );
}

function scopeOf(params: { stateDir: string; baseUrl: string; req: DaemonWireRequest }): Scope {
  const lease = leaseScopeFromRequest(params.req);
  const key = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        withoutTrailingSlashes(params.baseUrl),
        lease.tenantId ?? '',
        lease.runId ?? '',
        lease.leaseId ?? '',
        params.req.session ?? '',
      ]),
    )
    .digest('hex');
  const dir = path.join(params.stateDir, 'remote-connections', 'capture-destinations');
  return { dir, file: path.join(dir, `${key}.json`), req: params.req };
}

/** Runs one store step. A failure becomes the typed degraded warning, never a blocked request. */
async function storeStep<T>(
  warnings: RecordingDestinationWarning[],
  step: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await step();
  } catch {
    warnings.push({ reason: 'capture_destination_store_unavailable' });
    return undefined;
  }
}

async function saveGrant(scope: Scope, destination: string): Promise<string> {
  if (Buffer.byteLength(destination, 'utf8') > MAX_DESTINATION_BYTES) {
    throw storeError('The recording destination path is too long to save.');
  }
  const id = crypto.randomUUID();
  await updateGrants(
    scope,
    (grants) => {
      const now = Date.now();
      const kept = grants.filter((grant) => grant.createdAtMs >= now - STALE_RECORD_MS);
      while (kept.length >= MAX_GRANTS_PER_SCOPE) {
        const pending = kept.findIndex((grant) => !grant.accepted);
        kept.splice(pending === -1 ? 0 : pending, 1);
      }
      return [...kept, { id, destination, createdAtMs: now, accepted: false }];
    },
    true,
  );
  return id;
}

/** Rewrites one scope file under the store lock. A read failure keeps the prior file. */
async function updateGrants(
  scope: Scope,
  change: (grants: Grant[]) => Grant[],
  create = false,
): Promise<void> {
  await withRemoteStateLock(
    {
      lockDirPath: `${scope.dir}.lock`,
      description: 'remote capture destination store',
      timeoutMs: STORE_LOCK_TIMEOUT_MS,
    },
    async () => {
      if (!verifyStoreDir(scope.dir, create)) return;
      if (create) removeStaleScopeFiles(scope.dir);
      const next = change(readScopeFile(scope.file));
      if (next.length === 0) fs.rmSync(scope.file, { force: true });
      else
        publishFileSync({
          destination: scope.file,
          contents: `${JSON.stringify(next)}\n`,
          mode: 0o600,
        });
    },
  );
}

function readGrants(scope: Scope): Grant[] {
  if (!verifyStoreDir(scope.dir, false)) return [];
  const now = Date.now();
  return readScopeFile(scope.file).filter((grant) => grant.createdAtMs >= now - STALE_RECORD_MS);
}

/**
 * Verifies the store directory: a real directory, owned by this user, closed to others. Returns
 * false when it is absent and `create` is false. Throws a typed failure for anything else.
 */
function verifyStoreDir(dir: string, create: boolean): boolean {
  let stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat === undefined) {
    if (!create) return false;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(dir);
  }
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))
  ) {
    throw storeError('The recording destination store is not a private directory of this user.');
  }
  return true;
}

/** Reads one private regular scope file without following links, and validates it in full. */
function readScopeFile(file: string): Grant[] {
  const descriptor = openVerifiedFileForRead(file);
  if (descriptor === undefined) return [];
  try {
    const stat = fs.fstatSync(descriptor);
    const uid = process.getuid?.();
    if (stat.size > MAX_SCOPE_FILE_BYTES || (uid !== undefined && stat.uid !== uid)) {
      throw storeError(
        'A recording destination store file is too large or not owned by this user.',
      );
    }
    const grants = parseGrants(fs.readFileSync(descriptor, 'utf8'));
    if (grants === undefined) throw storeError('A recording destination store file is malformed.');
    return grants;
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseGrants(contents: string): Grant[] | undefined {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > MAX_GRANTS_PER_SCOPE) return undefined;
  const ids = new Set<string>();
  for (const grant of value as Partial<Grant>[]) {
    if (
      typeof grant?.id !== 'string' ||
      !GRANT_ID_PATTERN.test(grant.id) ||
      ids.has(grant.id) ||
      typeof grant.destination !== 'string' ||
      grant.destination.length === 0 ||
      !Number.isFinite(grant.createdAtMs) ||
      typeof grant.accepted !== 'boolean' ||
      Object.keys(grant).length !== 4
    ) {
      return undefined;
    }
    ids.add(grant.id);
  }
  return value as Grant[];
}

function removeStaleScopeFiles(dir: string): void {
  const cutoff = Date.now() - STALE_RECORD_MS;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isFile() && stat.mtimeMs < cutoff) fs.rmSync(file, { force: true });
  }
}

function storeError(message: string): AppError {
  return new AppError('COMMAND_FAILED', message, {
    reason: 'capture_destination_store_unavailable',
  });
}

/**
 * Whether a response `localPath` derives from a saved destination: the exact path, the path with
 * the recording extension that the producer appends when the path has none, the telemetry path of
 * that primary, or a `part-NNN` chunk path of that primary.
 */
function derives(destination: string, field: string, localPath: unknown): boolean {
  if (typeof localPath !== 'string' || localPath.length === 0) return false;
  return primaryForms(destination).some((primary) => {
    if (field === 'outPath') return primary === localPath;
    if (field === 'telemetryPath') return deriveRecordingTelemetryPath(primary) === localPath;
    if (field === 'chunkPath') return isDerivedChunkPath(primary, localPath);
    return false;
  });
}

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
