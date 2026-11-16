import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type {
  DaemonArtifact,
  DaemonResponse,
  ScriptDeliveryFailure,
} from '@agent-device/kernel/contracts';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { acquireProcessLock, publishFileSync, withProcessLock } from '@agent-device/host-kit/file';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import type { DaemonArtifactEndpoint, downloadRemoteArtifact } from './daemon-artifacts.ts';

/** The download stops at this size, so a daemon cannot fill the caller's disk. */
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
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
/** A published destination, `undefined` when no record matches, or a typed delivery failure. */
type PublishOutcome =
  | Readonly<{ published: string | undefined }>
  | Readonly<{ failure: ScriptDeliveryFailure; error: unknown }>;

type ScriptRecord = Readonly<{
  destination: string;
  force: boolean;
  revision: number;
  publishing?: Readonly<{ revision: number; file: string; staging: string }>;
  staging?: readonly string[];
  retired?: true;
}>;

type RemoteEndpoint = DaemonArtifactEndpoint & { capabilities?: readonly string[] };

/**
 * Sends a remote `open --save-script`. Before the open leaves, the client mints a publication ID
 * and records the caller destination and the `--force` grant under it. The serialized request
 * carries the ID and omits the destination. A daemon answer that does not name the ID removes the
 * record. A failed open may still have armed the recording, so it keeps the record. A record that outlives its open stays inert: only artifacts of its
 * own ID match it.
 */
export async function sendRemoteScriptOpen(
  info: RemoteEndpoint,
  req: DaemonWireRequest,
  stateDir: string,
  send: (req: DaemonWireRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  assertScriptArtifactsCapability(info.capabilities);
  const { savedScript: destination, ...clientArtifactPaths } = req.meta?.clientArtifactPaths ?? {};
  if (!info.baseUrl || !destination) throw new Error('A remote script open needs a destination.');
  const publicationId = crypto.randomUUID();
  const file = recordPath(stateDir, info.baseUrl, req, publicationId);
  await createRecord(file, { destination, force: req.flags?.force === true, revision: 0 });
  const meta = { ...req.meta, clientArtifactPaths, scriptPublicationId: publicationId };
  const response = await send({ ...req, meta });
  if (!response.ok || response.data?.scriptPublicationId !== publicationId) {
    // A record that cannot be removed stays inert, so the open's own outcome is reported.
    await withRecordLock(file, async () => fs.rmSync(file, { force: true })).catch(() => {});
  }
  return response;
}

export type SessionScriptDelivery = Readonly<{
  /** Publishes one script artifact and names it in `data`, or drops it from the response. */
  publish(
    artifact: DaemonArtifact,
    data: Record<string, unknown>,
    kept: DaemonArtifact[],
  ): Promise<void>;
  /** Runs the downloads of one response, then retires the record a close names. */
  settleAfter(
    run: (scripts: SessionScriptDelivery) => Promise<DaemonResponse>,
  ): Promise<DaemonResponse>;
}>;

/**
 * Publishes the session-script artifacts of one remote response to the destinations this client
 * recorded, and retires the record a close names: the one this request's own `close` answer names, or
 * the one `closedPublicationId` names when the caller is answering for a close it already ran. A
 * version that cannot be saved keeps the response successful and adds `scriptDeliveryFailure` and a
 * warning. A close retires its record even when another artifact fails, and the first error is the one
 * reported.
 */
export function sessionScriptDelivery(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
  closedPublicationId?: unknown,
): SessionScriptDelivery {
  const closedId =
    typeof closedPublicationId === 'string'
      ? closedPublicationId
      : req.command === 'close' && typeof response.data?.scriptPublicationId === 'string'
        ? response.data.scriptPublicationId
        : undefined;
  const retire = async (): Promise<void> => {
    if (closedId === undefined) return;
    const file = recordPath(stateDir, endpoint.baseUrl, req, closedId);
    await withRecordLock(file, async () => removeRecord(file));
  };
  const delivery: SessionScriptDelivery = {
    publish: async (artifact, data, kept) => {
      delete data[artifact.field];
      const outcome = await publishScriptVersion({ endpoint, req, stateDir, download }, artifact);
      if ('failure' in outcome) {
        // A delivery failure never changes the outcome of the action that recorded the version.
        const { failure, error } = outcome;
        data.scriptDeliveryFailure = failure;
        data.warnings = [...readResponseWarnings(data), `${failure.message} ${failure.hint}`];
        emitDiagnostic({
          level: 'warn',
          phase: 'session_script_delivery_failed',
          data: { session: req.session, error: String(error) },
        });
        return;
      }
      const { published } = outcome;
      if (published === undefined) return;
      data.savedScript = published;
      kept.push({ ...artifact, localPath: published });
    },
    settleAfter: async (run) => {
      // A record that cannot be retired stays inert, so the close keeps its own outcome.
      const retireQuietly = () =>
        retire().catch((retireError: unknown) =>
          emitDiagnostic({
            level: 'warn',
            phase: 'session_script_retire_failed',
            data: { session: req.session, error: String(retireError) },
          }),
        );
      try {
        return await run(delivery);
      } finally {
        await retireQuietly();
      }
    },
  };
  return delivery;
}

/**
 * Whether one artifact names a version this client can publish: the `savedScript` field, the
 * session-script type, a string publication ID and artifact ID, and a positive integer revision.
 * `publishScriptVersion` refuses anything else, and the batch path reads an untrusted answer through
 * this same guard, so no response value that cannot name a version reaches a record lookup, a path, or
 * a download request.
 */
export function isPublishableScriptVersion(artifact: DaemonArtifact | undefined): boolean {
  return (
    artifact?.field === 'savedScript' &&
    artifact.artifactType === 'session-script' &&
    typeof artifact.scriptPublicationId === 'string' &&
    typeof artifact.artifactId === 'string' &&
    Number.isSafeInteger(artifact.scriptRevision) &&
    (artifact.scriptRevision as number) > 0
  );
}

/**
 * Publishes one version and returns the destination, `undefined` when no record of this client
 * matches the artifact, or a typed delivery failure. A version no newer than the one published is
 * skipped.
 *
 * The download streams, capped at `MAX_SCRIPT_BYTES`, into a new private file in a private staging
 * directory beside the destination, so it moves into place by one rename or link. The compare and
 * the publish run under the record lock. The first version is linked exclusively unless the open
 * granted `--force`, as a local close-time write is.
 */
async function publishScriptVersion(
  context: Readonly<{
    endpoint: Required<DaemonArtifactEndpoint>;
    req: DaemonWireRequest;
    stateDir: string;
    download: typeof downloadRemoteArtifact;
  }>,
  artifact: DaemonArtifact,
): Promise<PublishOutcome> {
  const { endpoint, req, stateDir } = context;
  const { scriptPublicationId: id, scriptRevision: revision, artifactId } = artifact;
  const file = isPublishableScriptVersion(artifact)
    ? recordPath(stateDir, endpoint.baseUrl, req, id as string)
    : undefined;
  const record = file ? readRecord(file) : undefined;
  if (!file || !record) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_artifact_dropped',
      data: { session: req.session, artifactId },
    });
    return { published: undefined };
  }
  if ((revision as number) <= record.revision) return { published: record.destination };
  const directory = path.dirname(record.destination);
  const pending = { named: false };
  let staging: string | undefined;
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    staging = await withRecordLock(file, async () => allocateStaging(file, directory));
    if (!staging) return { published: undefined };
    const staged = path.join(staging, 'script.ad');
    await context.download({
      ...endpoint,
      artifactId: artifactId as string,
      destinationPath: staged,
      requestScope: req.meta,
      privateFile: { maxBytes: MAX_SCRIPT_BYTES },
    });
    const version = { revision: revision as number, staging, staged, pending };
    return { published: await withRecordLock(file, async () => publishStaged(file, version)) };
  } catch (error) {
    const closing = req.command === 'close';
    return {
      failure: scriptDeliveryFailure(record.destination, id as string, error, closing),
      error,
    };
  } finally {
    const removed = staging;
    if (removed && !pending.named) {
      // A directory that cannot be released here stays listed, so retirement or the sweep removes it.
      await withRecordLock(file, async () => releaseStaging(file, removed)).catch(() => undefined);
    }
  }
}

/** Creates a staging directory and lists it in the record before any script bytes reach it. */
function allocateStaging(file: string, directory: string): string | undefined {
  const record = readRecord(file);
  if (!record) return undefined;
  const staging = fs.mkdtempSync(path.join(directory, '.agent-device-script-'));
  try {
    writeRecord(file, { ...record, staging: [...(record.staging ?? []), staging] });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return staging;
}

/**
 * Removes a staging directory the record can no longer name, then unlists it, so a directory that
 * cannot be removed stays listed for retirement or the sweep.
 */
function releaseStaging(file: string, staging: string): void {
  fs.rmSync(staging, { recursive: true, force: true });
  const record = readRecord(file);
  if (record) writeRecord(file, withoutStaging(record, staging));
}

function withoutStaging(record: ScriptRecord, staging: string): ScriptRecord {
  return { ...record, staging: (record.staging ?? []).filter((listed) => listed !== staging) };
}

/**
 * Ends a record, then removes every staging directory it lists and the record itself. The record is
 * first written retired, so it authorizes nothing more even when a staging directory cannot be
 * removed; the sweep finishes the cleanup later. Writing it retired also stops it naming an
 * interrupted version, so no anchor is removed while the record names its inode. A record that
 * cannot be written retired is removed at once. Only a state directory that allows neither write
 * leaves the record active; the close logs that failure and keeps its own outcome.
 */
function removeRecord(file: string): void {
  const record = parseRecord(file);
  if (record && !record.retired) {
    try {
      writeRecord(file, { ...settlePublishing(record), retired: true });
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

/**
 * Runs under the record lock. While `pending.named` is set the record may name the staged file, so
 * the staged file stays on disk and no later file can reuse its inode and pass as that version.
 */
function publishStaged(
  file: string,
  version: Readonly<{
    revision: number;
    staging: string;
    staged: string;
    pending: { named: boolean };
  }>,
): string | undefined {
  const { revision, staging, staged, pending } = version;
  const record = readRecord(file);
  if (!record) return undefined;
  let current = settlePublishing(record);
  if (record.publishing) {
    // Once the settled record is written, its staging directory can no longer be named.
    writeRecord(file, current);
    releaseStaging(file, record.publishing.staging);
    current = withoutStaging(current, record.publishing.staging);
  }
  if (revision <= current.revision) return current.destination;
  const publishing = { revision, file: fileIdentity(staged) ?? 'missing', staging };
  // A second name keeps the inode on disk after the rename while the record may name it.
  fs.linkSync(staged, `${staged}.anchor`);
  writeRecord(file, { ...current, publishing });
  pending.named = true;
  const exclusive = current.revision === 0 && !current.force;
  try {
    if (exclusive) fs.linkSync(staged, current.destination);
    else fs.renameSync(staged, current.destination);
  } catch (error) {
    writeRecord(file, settlePublishing({ ...current, publishing }));
    pending.named = false;
    throw error;
  }
  writeRecord(file, { ...current, revision });
  pending.named = false;
  return current.destination;
}

/** An interrupted version counts as published only when the destination is that very file. */
function settlePublishing(record: ScriptRecord): ScriptRecord {
  const { publishing, ...settled } = record;
  if (!publishing) return record;
  if (fileIdentity(record.destination) !== publishing.file) return settled;
  return { ...settled, revision: Math.max(settled.revision, publishing.revision) };
}

function fileIdentity(file: string): string | undefined {
  const stat = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat ? `${stat.dev}:${stat.ino}` : undefined;
}

function scriptDeliveryFailure(
  destination: string,
  publicationId: string,
  error: unknown,
  closing: boolean,
): ScriptDeliveryFailure {
  // Only the exclusive link of the first version can find an existing entry.
  const exists = (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
  const recovery = closing
    ? 'The session is closed, so no later version follows.'
    : 'The next recorded action or close delivers the full recording again.';
  return exists
    ? {
        reason: 'script_delivery_failed',
        cause: 'script_target_exists',
        publicationId,
        message: `A file already exists at ${destination}.`,
        hint: 'Remove the existing file, or start a new recording with open --save-script --force.',
      }
    : {
        reason: 'script_delivery_failed',
        cause: 'script_download_failed',
        publicationId,
        message: `The remote script could not be saved to ${destination}.`,
        hint: `The file may still hold the previous version. ${recovery}`,
      };
}

function recordPath(
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
async function createRecord(file: string, record: ScriptRecord): Promise<void> {
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
function readRecord(file: string): ScriptRecord | undefined {
  const record = parseRecord(file);
  return record?.retired ? undefined : record;
}

function parseRecord(file: string): ScriptRecord | undefined {
  let record: Partial<ScriptRecord> | null = null;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  const publishing = record?.publishing;
  const valid =
    typeof record?.destination === 'string' &&
    typeof record.force === 'boolean' &&
    Number.isSafeInteger(record.revision) &&
    (publishing === undefined ||
      (Number.isSafeInteger(publishing?.revision) &&
        typeof publishing?.file === 'string' &&
        typeof publishing?.staging === 'string')) &&
    (record.retired === undefined || record.retired === true) &&
    (record.staging === undefined ||
      (Array.isArray(record.staging) &&
        record.staging.every((staging) => typeof staging === 'string')));
  return valid ? (record as ScriptRecord) : undefined;
}

function writeRecord(file: string, record: ScriptRecord): void {
  publishFileSync({ destination: file, contents: `${JSON.stringify(record)}\n`, mode: 0o600 });
}

async function withRecordLock<T>(file: string, task: () => Promise<T>): Promise<T> {
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
