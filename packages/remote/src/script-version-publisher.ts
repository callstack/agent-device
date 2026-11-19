import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, ScriptDeliveryFailure } from '@agent-device/kernel/contracts';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  confirmScriptDestination,
  openVerifiedFileForRead,
  scriptAncestryReason,
  prepareScriptDestination,
  type ScriptDestination,
} from '@agent-device/host-kit/file';
import type { DaemonArtifactEndpoint, downloadRemoteArtifact } from './daemon-artifacts.ts';
import {
  readRecord,
  recordPath,
  withRecordLock,
  withoutPublishing,
  withoutStaging,
  writeRecord,
  type ScriptRecord,
} from './script-publication-record.ts';

/** The download stops at this size, so a daemon cannot fill the caller's disk. */
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * A published destination, `undefined` when no record matches, or a typed delivery failure. `repeat` marks a
 * version answered from the record alone, without looking at the file: the revision asked for, the revision the
 * record last confirmed, which is newer when the version asked for was superseded, and an interrupted save the
 * record names, which may already have replaced the file.
 */
export type PublishOutcome =
  | Readonly<{
      published: string | undefined;
      repeat?: Readonly<{ requested: number; committed: number; pending?: number }>;
    }>
  | Readonly<{ failure: ScriptDeliveryFailure; error: unknown }>;

/**
 * Publishes one version and returns the destination, `undefined` when no record of this client
 * matches the artifact, or a typed delivery failure. A version no newer than the one published is
 * answered from the record: nothing is downloaded, and the saved file is neither read nor judged again.
 * `closesRecording` says this version is the last one any later command will ask for, so
 * the failure hint offers the recovery that is actually left.
 *
 * The download streams, capped at `MAX_SCRIPT_BYTES`, into a new private file in a private staging
 * directory beside the destination, so it moves into place by one rename or link. The compare and
 * the publish run under the record lock. The first version is linked exclusively unless the open
 * granted `--force`, as a local close-time write is.
 */
export async function publishScriptVersion(
  context: Readonly<{
    endpoint: Required<DaemonArtifactEndpoint>;
    req: DaemonWireRequest;
    stateDir: string;
    download: typeof downloadRemoteArtifact;
  }>,
  artifact: DaemonArtifact,
  closesRecording: boolean,
): Promise<PublishOutcome> {
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
    return { published: undefined };
  }
  const pending = { named: false };
  let staging: string | undefined;
  try {
    // Decided from the record as the lock holds it, never from the snapshot above, in the same operation that
    // judges the destination and allocates staging.
    const allocated = await withRecordLock(file, async () =>
      stageOrAnswer(file, revision as number),
    );
    if (!('staging' in allocated)) return allocated;
    const { prepared } = allocated;
    staging = allocated.staging;
    const staged = path.join(allocated.staging, 'script.ad');
    try {
      await context.download({
        ...endpoint,
        artifactId: artifactId as string,
        destinationPath: staged,
        requestScope: req.meta,
        privateFile: { maxBytes: MAX_SCRIPT_BYTES },
      });
    } catch (error) {
      // Another delivery may have committed this version meanwhile, or installed it and been interrupted; a
      // failed fetch is only this client's failure while neither holds. The staging cleanup and that decision
      // take ONE lock.
      const released = allocated.staging;
      const committed = await withRecordLock(file, async () => {
        staging = undefined;
        releaseStagingQuietly(file, released);
        return settledRepeat(file, revision as number, prepared);
      });
      // Only a published path answers the call; a record a concurrent close retired leaves the fetch error.
      if (committed && 'published' in committed && committed.published !== undefined)
        return committed;
      throw error;
    }
    const version = {
      revision: revision as number,
      staging: allocated.staging,
      staged,
      // What host-kit answered above, carried for the one confirmation before the rename.
      prepared,
      pending,
    };
    return await withRecordLock(file, async () => publishStaged(file, version));
  } catch (error) {
    return {
      failure: scriptDeliveryFailure(record.destination, id as string, error, closesRecording),
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

/**
 * Runs under the record lock, as one operation: answers a version the record committed before the destination is
 * judged, or else prepares the destination, answers a version an interrupted commit installed, or creates a staging
 * directory in the ground host-kit judged and lists it in the record before any script bytes reach it (ADR 0016).
 */
function stageOrAnswer(
  file: string,
  revision: number,
): PublishOutcome | Readonly<{ staging: string; prepared: ScriptDestination }> {
  const record = readRecord(file);
  if (!record) return { published: undefined };
  const repeated = committedRepeat(record, revision);
  if (repeated) return repeated;
  // host-kit owns the whole creation sequence (ADR 0016), and its answer is where staging goes.
  const prepared = prepareScriptDestination(record.destination);
  const current = settleNamedInterruption(file, record, revision, prepared);
  const promoted = committedRepeat(current, revision);
  if (promoted) return promoted;
  const staging = fs.mkdtempSync(path.join(prepared.directory, '.agent-device-script-'));
  try {
    writeRecord(file, { ...current, staging: [...(current.staging ?? []), staging] });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { staging, prepared };
}

/** Releases a staging directory; one that cannot be removed stays listed, for retirement or the sweep. */
function releaseStagingQuietly(file: string, staging: string): void {
  try {
    releaseStaging(file, staging);
  } catch {}
}

/** Unlists staging only after removal succeeds. */
function releaseStaging(file: string, staging: string): void {
  fs.rmSync(staging, { recursive: true, force: true });
  const record = readRecord(file);
  if (record) writeRecord(file, withoutStaging(record, staging));
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
    prepared: ScriptDestination;
    pending: { named: boolean };
  }>,
): PublishOutcome {
  const { revision, staging, staged, prepared, pending } = version;
  const record = readRecord(file);
  if (!record) return { published: undefined };
  // A copy that became a repeat while it downloaded is answered exactly as an early repeat is.
  const repeated = committedRepeat(record, revision);
  if (repeated) return repeated;
  // Confirmed here, under the record lock, because the download ran since host-kit answered. The entry it
  // returns is the only path this commit creates or probes: the destination's own spelling never reaches the
  // filesystem, and nothing the record stores can point recovery elsewhere (ADR 0016).
  const { entry } = confirmScriptDestination(record.destination, prepared);
  const current = settleInterrupted(file, record, entry);
  const promoted = committedRepeat(current, revision);
  if (promoted) return promoted;
  const publishing = { revision, file: verifiedStagedIdentity(staged), staging };
  // A second name keeps the inode on disk after the rename while the record may name it.
  fs.linkSync(staged, `${staged}.anchor`);
  writeRecord(file, { ...current, publishing });
  pending.named = true;
  const exclusive = current.revision === 0 && !current.force;
  try {
    if (exclusive) fs.linkSync(staged, entry);
    else fs.renameSync(staged, entry);
  } catch (error) {
    writeRecord(file, settlePublishing({ ...current, publishing }, entry));
    pending.named = false;
    throw error;
  }
  writeRecord(file, { ...current, revision });
  pending.named = false;
  return { published: entry };
}

/**
 * Answers a version the record already committed with the stored absolute destination, without touching
 * the filesystem, or nothing when the version is newer. An interrupted save the record names is disclosed, since
 * it may already have replaced the file.
 */
function committedRepeat(record: ScriptRecord, revision: number): PublishOutcome | undefined {
  if (revision > record.revision) return undefined;
  const pending = record.publishing?.revision;
  return {
    published: record.destination,
    repeat: { requested: revision, committed: record.revision, ...(pending ? { pending } : {}) },
  };
}

/**
 * Runs under the record lock: answers a version the record committed, or settles an interrupted commit that
 * names it against the entry host-kit confirms and answers it when that commit installed it. Nothing when the
 * version still needs to be staged.
 */
function settledRepeat(
  file: string,
  revision: number,
  prepared: ScriptDestination,
): PublishOutcome | undefined {
  const record = readRecord(file);
  if (!record) return { published: undefined };
  return (
    committedRepeat(record, revision) ??
    committedRepeat(settleNamedInterruption(file, record, revision, prepared), revision)
  );
}

/**
 * Runs under the record lock: settles an interrupted commit that names `revision` against the entry host-kit
 * confirms, and returns the record as settled, or the record unchanged when no such commit is pending.
 */
function settleNamedInterruption(
  file: string,
  record: ScriptRecord,
  revision: number,
  prepared: ScriptDestination,
): ScriptRecord {
  if (revision > (record.publishing?.revision ?? 0)) return record;
  const { entry } = confirmScriptDestination(record.destination, prepared);
  return settleInterrupted(file, record, entry);
}

/**
 * The identity of a staged script that is a readable regular file within the delivery cap and stayed unchanged
 * while it was read through one verified descriptor; anything else is not committed. No content digest is kept; the
 * identity returned is the pending file identity the record names until the commit settles.
 */
function verifiedStagedIdentity(staged: string): string {
  const descriptor = openVerifiedFileForRead(staged);
  if (descriptor === undefined) throw new Error('The staged script is missing.');
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (opened.size > BigInt(MAX_SCRIPT_BYTES)) {
      throw new Error('The staged script is not within the delivery cap.');
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (let read = -1; read !== 0 && total <= MAX_SCRIPT_BYTES; total += read) {
      read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const standing = fs.lstatSync(staged, { bigint: true });
    if (total > MAX_SCRIPT_BYTES || BigInt(total) !== opened.size) {
      throw new Error('The staged script is not within the delivery cap.');
    }
    if (!sameUnchangedFile(opened, after) || !sameUnchangedFile(after, standing)) {
      throw new Error('The staged script changed while it was checked.');
    }
    return `${opened.dev}:${opened.ino}`;
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameUnchangedFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Settles a version a crash left between its rename and its revision update, against the entry host-kit just
 * confirmed, and removes that version's staging once the record no longer names it.
 */
function settleInterrupted(file: string, record: ScriptRecord, entry: string): ScriptRecord {
  if (!record.publishing) return record;
  const settled = settlePublishing(record, entry);
  // Write the settled commit before releasing its inode anchor. Keep staging listed until removal succeeds.
  writeRecord(file, settled);
  // Best effort once the commit is recorded: a directory that stays listed is removed by retirement or the sweep.
  releaseStagingQuietly(file, record.publishing.staging);
  return readRecord(file) ?? settled;
}

/** An interrupted version counts as published only when the entry host-kit authorized is that very file. */
function settlePublishing(record: ScriptRecord, entry: string): ScriptRecord {
  const { publishing } = record;
  if (!publishing) return record;
  const settled = withoutPublishing(record);
  if (fileIdentity(entry) !== publishing.file) return settled;
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
  const refusal = scriptAncestryReason(error);
  if (refusal) {
    return {
      reason: 'script_delivery_failed',
      cause: refusal,
      publicationId,
      message:
        error instanceof AppError
          ? error.message
          : `The remote script could not be saved to ${destination}.`,
      hint: error instanceof AppError ? (error.details?.hint ?? '') : '',
    };
  }
  const recovery = closing
    ? 'The session is closed, so no later version follows.'
    : 'The next recorded action or close delivers the full recording again.';
  return exists
    ? {
        reason: 'script_delivery_failed',
        cause: 'script_target_exists',
        publicationId,
        message: `A file already exists at ${destination}.`,
        hint: `Remove the existing file, or start a new recording by reusing your original open command with ${recordAgainArguments(destination)}.`,
      }
    : {
        reason: 'script_delivery_failed',
        cause: 'script_download_failed',
        publicationId,
        message: `The remote script could not be saved to ${destination}.`,
        hint: `The file may still hold the previous version. ${recovery}`,
      };
}

/**
 * The arguments that record again to the same file; a bare `--save-script` would pick a new file name. A path with a
 * C0 or C1 control character cannot survive a rendered text line, so they name a placeholder for it instead.
 */
export function recordAgainArguments(destination: string): string {
  const control = (char: string) => char < ' ' || (char >= '\u007f' && char <= '\u009f');
  if ([...destination].some(control)) {
    return '--save-script=<path> --force, with the path quoted for your shell';
  }
  return `--save-script=${shellQuoteIfNeeded(destination)} --force`;
}
