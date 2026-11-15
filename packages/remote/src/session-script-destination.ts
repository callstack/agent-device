import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type {
  DaemonArtifact,
  DaemonResponse,
  ScriptDeliveryFailure,
} from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
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
 * ones a crashed download left behind.
 */
type ScriptRecord = Readonly<{
  destination: string;
  force: boolean;
  revision: number;
  publishing?: Readonly<{ revision: number; file: string; staging: string }>;
  staging?: readonly string[];
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
 * recorded, and retires the record that a close names. A version that cannot be saved keeps the
 * response successful and adds `scriptDeliveryFailure` and a warning. A close retires its record
 * even when another artifact fails, and the first error is the one reported.
 */
export function sessionScriptDelivery(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
): SessionScriptDelivery {
  const named = response.data?.scriptPublicationId;
  const closedId = req.command === 'close' && typeof named === 'string' ? named : undefined;
  const retire = async (): Promise<void> => {
    if (closedId === undefined) return;
    const file = recordPath(stateDir, endpoint.baseUrl, req, closedId);
    await withRecordLock(file, async () => removeRecord(file));
  };
  const delivery: SessionScriptDelivery = {
    publish: async (artifact, data, kept) => {
      delete data[artifact.field];
      let published: string | undefined;
      try {
        published = await publishScriptVersion({ endpoint, req, stateDir, download }, artifact);
      } catch (error) {
        // A delivery failure never changes the outcome of the action that recorded the version.
        const saved = error as AppError;
        // Only a validated script artifact reaches the save, so its publication ID is a string.
        const failure: ScriptDeliveryFailure = {
          reason: 'script_delivery_failed',
          cause: String(saved.details?.reason),
          publicationId: String(artifact.scriptPublicationId),
          message: saved.message,
          hint: String(saved.details?.hint),
        };
        data.scriptDeliveryFailure = failure;
        data.warnings = [...readResponseWarnings(data), `${failure.message} ${failure.hint}`];
        emitDiagnostic({
          level: 'warn',
          phase: 'session_script_delivery_failed',
          data: { session: req.session, error: String(saved.cause ?? saved) },
        });
        return;
      }
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
      let result: DaemonResponse;
      try {
        result = await run(delivery);
      } catch (error) {
        await retireQuietly();
        throw error;
      }
      await retireQuietly();
      return result;
    },
  };
  return delivery;
}

/**
 * Publishes one version and returns the destination, or `undefined` when no record of this client
 * matches the artifact. A version no newer than the one published is skipped.
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
): Promise<string | undefined> {
  const { endpoint, req, stateDir } = context;
  const { scriptPublicationId: id, scriptRevision: revision, artifactId } = artifact;
  const file =
    artifact.field === 'savedScript' &&
    artifact.artifactType === 'session-script' &&
    typeof id === 'string' &&
    typeof artifactId === 'string' &&
    Number.isSafeInteger(revision) &&
    (revision as number) > 0
      ? recordPath(stateDir, endpoint.baseUrl, req, id)
      : undefined;
  const record = file ? readRecord(file) : undefined;
  if (!file || !record) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_artifact_dropped',
      data: { session: req.session, artifactId },
    });
    return undefined;
  }
  if ((revision as number) <= record.revision) return record.destination;
  const directory = path.dirname(record.destination);
  const pending = { named: false };
  let staging: string | undefined;
  try {
    await fs.promises.mkdir(directory, { recursive: true });
    staging = await withRecordLock(file, async () => allocateStaging(file, directory));
    if (!staging) return undefined;
    const staged = path.join(staging, 'script.ad');
    await context.download({
      ...endpoint,
      artifactId: artifactId as string,
      destinationPath: staged,
      requestScope: req.meta,
      privateFile: { maxBytes: MAX_SCRIPT_BYTES },
    });
    const version = { revision: revision as number, staging, staged, pending };
    return await withRecordLock(file, async () => publishStaged(file, version));
  } catch (error) {
    throw scriptSaveError(record.destination, artifactId, error, req.command === 'close');
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
 * Removes a record and every staging directory it lists. The record first stops naming an
 * interrupted version, so no anchor is removed while the record names its inode, and a failure
 * keeps the list.
 */
function removeRecord(file: string): void {
  const record = readRecord(file);
  if (record?.publishing) writeRecord(file, settlePublishing(record));
  for (const staging of record?.staging ?? []) {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  fs.rmSync(file, { force: true });
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

function scriptSaveError(
  destination: string,
  artifactId: string | undefined,
  error: unknown,
  closing: boolean,
) {
  const cause = error instanceof Error ? error : undefined;
  // Only the exclusive link of the first version can find an existing entry.
  const exists = (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
  const recovery = closing
    ? 'The session is closed, so no later version follows.'
    : 'The next recorded action or close delivers the full recording again.';
  return new AppError(
    'COMMAND_FAILED',
    exists
      ? `A file already exists at ${destination}.`
      : `The remote script could not be saved to ${destination}.`,
    {
      reason: exists ? 'script_target_exists' : 'script_download_failed',
      path: destination,
      artifactId,
      hint: exists
        ? 'Remove the existing file, or start a new recording with open --save-script --force.'
        : `The file may still hold the previous version. ${recovery}`,
    },
    cause,
  );
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
        baseUrl.replace(/\/+$/, ''),
        req.meta?.tenantId ?? '',
        req.session ?? '',
        publicationId,
      ]),
    )
    .digest('hex');
  return path.join(stateDir, 'remote-connections', 'session-scripts', `${key}.json`);
}

/** Creates a record and removes the records nobody has touched for `STALE_RECORD_MS`. */
async function createRecord(file: string, record: ScriptRecord): Promise<void> {
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

/** A record that does not parse authorizes nothing. */
function readRecord(file: string): ScriptRecord | undefined {
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
