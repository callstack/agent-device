import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError, readDispatchDisclosure } from '@agent-device/kernel/errors';
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
 * identity, and the staging directory is removed once nothing can name it.
 */
type ScriptRecord = Readonly<{
  destination: string;
  force: boolean;
  revision: number;
  publishing?: Readonly<{ revision: number; file: string; staging: string }>;
}>;

type RemoteEndpoint = DaemonArtifactEndpoint & { capabilities?: readonly string[] };

/**
 * Sends a remote `open --save-script`. Before the open leaves, the client mints a publication ID
 * and records the caller destination and the `--force` grant under it. The serialized request
 * carries the ID and omits the destination. A refused open, or one that armed no recording,
 * removes the record; an open that may have armed one keeps it. A record that outlives its open stays inert: only artifacts of its
 * own ID match it.
 */
export async function sendRemoteScriptOpen(
  info: RemoteEndpoint,
  req: DaemonWireRequest,
  stateDir: string,
  send: (req: DaemonWireRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  if (!info.capabilities?.includes('script-artifacts')) {
    throw new AppError('INVALID_ARGS', 'The remote daemon cannot deliver session scripts.', {
      reason: 'remote_script_artifacts_unsupported',
      daemonRequestSent: false,
      hint: 'Upgrade the daemon that owns the session. Through a proxy, the upstream daemon must report the script-artifacts capability in its /health response.',
    });
  }
  const { savedScript: destination, ...clientArtifactPaths } = req.meta?.clientArtifactPaths ?? {};
  if (!info.baseUrl || !destination) throw new Error('A remote script open needs a destination.');
  const publicationId = crypto.randomUUID();
  const file = recordPath(stateDir, info.baseUrl, req, publicationId);
  createRecord(file, { destination, force: req.flags?.force === true, revision: 0 });
  const meta = { ...req.meta, clientArtifactPaths, scriptPublicationId: publicationId };
  let armed = false;
  try {
    const response = await send({ ...req, meta });
    armed = response.ok && response.data?.scriptPublicationId === publicationId;
    return response;
  } catch (error) {
    // The daemon armed the recording when only this machine failed to save its first version, and
    // may have armed it when the open was sent but its answer was lost.
    armed =
      error instanceof AppError &&
      (SAVE_FAILURES.has(String(error.details?.reason)) ||
        readDispatchDisclosure(error.details) === 'unknown');
    throw error;
  } finally {
    if (!armed) {
      // A record that cannot be removed stays inert, so the open's own outcome is reported.
      await withRecordLock(file, async () => fs.rmSync(file, { force: true })).catch(() => {});
    }
  }
}

/** The reasons `scriptSaveError` gives, after the daemon answered with a version. */
const SAVE_FAILURES = new Set(['script_download_failed', 'script_target_exists']);

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
 * recorded, and retires the record that a close names. A close retires it even when a download or
 * a write fails, and the first error is the one reported.
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
    await withRecordLock(file, async () => {
      const staging = readRecord(file)?.publishing?.staging;
      fs.rmSync(file, { force: true });
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    });
  };
  const delivery: SessionScriptDelivery = {
    publish: async (artifact, data, kept) => {
      const published = await publishScriptVersion({ endpoint, req, stateDir, download }, artifact);
      delete data[artifact.field];
      if (published === undefined) return;
      data.savedScript = published;
      kept.push({ ...artifact, localPath: published });
    },
    settleAfter: async (run) => {
      let result: DaemonResponse;
      try {
        result = await run(delivery);
      } catch (error) {
        await retire().catch((retireError: unknown) =>
          emitDiagnostic({
            level: 'warn',
            phase: 'session_script_retire_failed',
            data: { session: req.session, error: String(retireError) },
          }),
        );
        throw error;
      }
      await retire();
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
    staging = await fs.promises.mkdtemp(path.join(directory, '.agent-device-script-'));
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
    throw scriptSaveError(record.destination, artifactId, error);
  } finally {
    if (staging && !pending.named) {
      await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
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
  const current = settlePublishing(record);
  if (current !== record) {
    writeRecord(file, current);
    // The settled entry's staging directory can no longer be named.
    if (record.publishing) fs.rmSync(record.publishing.staging, { recursive: true, force: true });
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

function scriptSaveError(destination: string, artifactId: string | undefined, error: unknown) {
  const cause = error instanceof Error ? error : undefined;
  // Only the exclusive link of the first version can find an existing entry.
  const exists = (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
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
        : 'The previous script version is unchanged. The next recorded action or close delivers the full recording again.',
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
function createRecord(file: string, record: ScriptRecord): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const staleBefore = Date.now() - STALE_RECORD_MS;
  for (const name of fs.readdirSync(directory)) {
    const entry = path.join(directory, name);
    const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (name.endsWith('.json') && stat && stat.mtimeMs < staleBefore) {
      const staging = readRecord(entry)?.publishing?.staging;
      fs.rmSync(entry, { force: true });
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
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
        typeof publishing?.staging === 'string'));
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
