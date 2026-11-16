import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import { normalizeBatchCommandName } from '@agent-device/contracts/input-validation';
import type {
  DaemonArtifact,
  DaemonResponse,
  ScriptDeliveryFailure,
  ScriptDeliveryReceipt,
} from '@agent-device/kernel/contracts';
import { readScriptDeliveryReceipt } from '@agent-device/kernel/contracts';
import type { DaemonError } from '@agent-device/kernel/errors';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { AppError } from '@agent-device/kernel/errors';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  acquireProcessLock,
  assertPrivateScriptDestination,
  publishDirectoryIdentity,
  publishFileSync,
  withProcessLock,
} from '@agent-device/host-kit/file';
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
 * Settles the one delivery receipt a response names (ADR 0016, #4595): at most one version
 * downloaded, and a record retired only for a close validated against the plan this client submitted.
 *
 * The receipt is validated against THIS client's record — exact publication ID, tenant, session and
 * endpoint. A receipt naming a recording this client never opened under that scope authorizes nothing
 * and says so in the diagnostic, because a response never establishes a destination.
 */
async function settleScriptReceipt(
  context: Readonly<{
    endpoint: Required<DaemonArtifactEndpoint>;
    req: DaemonWireRequest;
    stateDir: string;
    download: typeof downloadRemoteArtifact;
  }>,
  receipt: ScriptDeliveryReceipt,
  disclose: (failure: ScriptDeliveryFailure, error: unknown) => void,
): Promise<ReceiptSettlement> {
  const { endpoint, req, stateDir } = context;
  const failures = [...(receipt.failures ?? [])];
  for (const failure of failures) disclose(failure, undefined);
  const file = recordPath(stateDir, endpoint.baseUrl, req, receipt.publicationId);
  const record = readRecord(file);
  if (!record) {
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_artifact_dropped',
      data: { session: req.session, publicationId: receipt.publicationId },
    });
    return { failures };
  }
  const closesOwnPlan = receipt.close !== undefined && closesSubmittedPlan(req, receipt.close.step);
  const published = receipt.version
    ? await publishScriptVersion(context, receipt.version, closesOwnPlan)
    : undefined;
  if (published && 'failure' in published) disclose(published.failure, published.error);
  const destination = published && 'published' in published ? published.published : undefined;
  return {
    ...(closesOwnPlan ? { retire: file } : {}),
    ...(destination !== undefined && receipt.version?.artifactId !== undefined
      ? { artifactId: receipt.version.artifactId, published: destination }
      : {}),
    failures,
  };
}

type ReceiptSettlement = {
  retire?: string;
  published?: string;
  artifactId?: string;
  failures: ScriptDeliveryFailure[];
};

/** Retires a record without letting a failure here replace the request's own outcome. */
function retireQuietly(req: DaemonWireRequest, file: string): Promise<void> {
  return withRecordLock(file, async () => removeRecord(file)).catch((retireError: unknown) =>
    emitDiagnostic({
      level: 'warn',
      phase: 'session_script_retire_failed',
      data: { session: req.session, error: String(retireError) },
    }),
  );
}

/**
 * Whether the batch plan this client submitted carries a `close` at 1-based position `step`. A
 * position past the plan, one whose command is not `close`, or a request that submitted no plan
 * authorizes no retirement.
 */
function closesSubmittedPlan(req: DaemonWireRequest, step: number): boolean {
  if (req.command !== 'batch') return false;
  const steps = req.flags?.batchSteps;
  if (!Array.isArray(steps) || step > steps.length) return false;
  return normalizeBatchCommandName(steps[step - 1]?.command) === 'close';
}

/**
 * Publishes the session-script artifacts of one remote response to the destinations this client
 * recorded, and retires the record that a close names. A version that cannot be saved keeps the
 * response successful and adds `scriptDeliveryFailure` and a warning. A close retires its record
 * even when another artifact fails, and the first error is the one reported.
 *
 * A response that names a delivery receipt (#4595) delivers THROUGH that receipt: at most its one
 * version is downloaded, and the receipt's failures and close are what the client acts on. The
 * session-script artifacts such a response still lists are then dropped rather than downloaded, so
 * one response never moves two versions. An entry that is not shaped as one script artifact is
 * dropped without touching any response field: a peer cannot erase a disclosure or a publication
 * this client already made.
 */
export function sessionScriptDelivery(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
): SessionScriptDelivery {
  const context = { endpoint, req, stateDir, download };
  const receipt = req.command === 'batch' ? readScriptDeliveryReceipt(response) : undefined;
  const rejected =
    receipt === undefined &&
    req.command === 'batch' &&
    response.data?.scriptDeliveryReceipt !== undefined
      ? unreadableReceiptFailure()
      : undefined;
  const named = response.data?.scriptPublicationId;
  const closedId = req.command === 'close' && typeof named === 'string' ? named : undefined;
  // The receipt's own version is downloaded before the artifact loop runs, so the loop learns the
  // published destination from here rather than downloading anything a second time.
  let settled: ReceiptSettlement | undefined;
  const delivery: SessionScriptDelivery = {
    publish: async (artifact, data, kept) => {
      if (artifact.field !== 'savedScript' || artifact.artifactType !== 'session-script') return;
      // The receipt is the one delivery instruction of this response; a step's or the batch's own
      // artifact entry is the same version it already names, so it is never downloaded a second time.
      if (req.command === 'batch') {
        if (settled?.published && artifact.artifactId === settled.artifactId) {
          data.savedScript = settled.published;
          kept.push({ ...artifact, localPath: settled.published });
        }
        return;
      }
      const outcome = await publishScriptVersion(context, artifact, req.command === 'close');
      if ('failure' in outcome) {
        // A delivery failure never changes the outcome of the action that recorded the version.
        discloseDeliveryFailure(data, req, outcome.failure, outcome.error);
        return;
      }
      const { published } = outcome;
      if (published === undefined) return;
      data.savedScript = published;
      kept.push({ ...artifact, localPath: published });
    },
    settleAfter: async (run) => {
      const data = response.data ?? {};
      if (rejected) discloseDeliveryFailure(data, req, rejected, undefined);
      settled = receipt
        ? await settleScriptReceipt(context, receipt, (failure, error) =>
            discloseDeliveryFailure(data, req, failure, error),
          )
        : undefined;
      try {
        return await run(delivery);
      } finally {
        // A record that cannot be retired stays inert, so the request keeps its own outcome.
        if (settled?.retire) await retireQuietly(req, settled.retire);
        else if (closedId !== undefined)
          await retireQuietly(req, recordPath(stateDir, endpoint.baseUrl, req, closedId));
      }
    },
  };
  return delivery;
}

function unreadableReceiptFailure(): ScriptDeliveryFailure {
  return {
    reason: 'script_delivery_failed',
    publicationId: '',
    message: 'The daemon answered a malformed script delivery receipt.',
    hint: 'No batch recording was delivered from it. Update the daemon or proxy, then run the batch again.',
  };
}

/**
 * Adds one delivery failure and its warning to a response body's disclosure fields. One field
 * reports the latest failure; all earlier failures remain in the receipt and their paired warnings —
 * the text of every failure still reaches the caller.
 */
function discloseDeliveryFailure(
  data: Record<string, unknown>,
  req: DaemonWireRequest,
  failure: ScriptDeliveryFailure,
  error: unknown,
): void {
  data.scriptDeliveryFailure = failure;
  data.warnings = [...readResponseWarnings(data), `${failure.message} ${failure.hint}`];
  emitDiagnostic({
    level: 'warn',
    phase: 'session_script_delivery_failed',
    data: { session: req.session, ...(error === undefined ? {} : { error: String(error) }) },
  });
}

/**
 * Settles the one delivery receipt a FAILED response names (#4595), where no successful-artifact
 * path runs: a batch that stopped mid-plan still delivers what its completed steps wrote. The
 * disclosure rides the error the caller receives. A close retires the record only when the failure
 * position is validated against the submitted plan and the close comes before that failure; nothing
 * else proves the close ran.
 */
export async function settleScriptDeliveryReceiptOfFailure(
  endpoint: Required<DaemonArtifactEndpoint>,
  req: DaemonWireRequest,
  error: DaemonError,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
): Promise<DaemonError> {
  if (req.command !== 'batch') return error;
  const receipt = readScriptDeliveryReceipt({ ok: false, error });
  if (!receipt) {
    if (error.details?.scriptDeliveryReceipt === undefined) return error;
    const details = { ...error.details };
    discloseDeliveryFailure(details, req, unreadableReceiptFailure(), undefined);
    return { ...error, details };
  }
  // An error whose failure position cannot be reconciled with the submitted plan makes the whole
  // answer untrustworthy, and an untrustworthy answer authorizes nothing.
  if (unreconcilableFailurePosition(req, error)) return error;
  // A validated position before the receipt's close proves the close step never ran, and a batch
  // can stop with no position at all (a request deadline, or a step that threw inside the runner).
  // Neither case proves a close, so the close is dropped; the version and the failures are facts the
  // daemon answered about THIS client's publication, so they still settle. Silently dropping them
  // would leave the caller file stale with no warning, which is what this disclosure exists for.
  const failedStep = validatedFailedBatchStep(req, error);
  const honored =
    receipt.close === undefined || (failedStep !== undefined && receipt.close.step < failedStep);
  const data: Record<string, unknown> = { ...(error.details ?? {}) };
  const settled = await settleScriptReceipt(
    { endpoint, req, stateDir, download },
    honored ? receipt : withoutClose(receipt),
    (failure, failureError) => discloseDeliveryFailure(data, req, failure, failureError),
  );
  if (settled.retire) await retireQuietly(req, settled.retire);
  const disclosure: Record<string, unknown> = {
    ...(data.scriptDeliveryFailure === undefined
      ? {}
      : { scriptDeliveryFailure: data.scriptDeliveryFailure }),
    ...(data.warnings === undefined ? {} : { warnings: data.warnings }),
  };
  if (Object.keys(disclosure).length === 0) return error;
  return { ...error, details: { ...(error.details ?? {}), ...disclosure } };
}

/** The receipt with its close dropped: its version and failures still settle, nothing retires. */
function withoutClose(receipt: ScriptDeliveryReceipt): ScriptDeliveryReceipt {
  return {
    publicationId: receipt.publicationId,
    ...(receipt.version === undefined ? {} : { version: receipt.version }),
    ...(receipt.failures === undefined ? {} : { failures: receipt.failures }),
  };
}

function unreconcilableFailurePosition(req: DaemonWireRequest, error: DaemonError): boolean {
  const { step, command } = error.details ?? {};
  if (step === undefined && command === undefined) return false;
  return validatedFailedBatchStep(req, error) === undefined;
}

/**
 * The batch step this error names, when the submitted plan carries exactly that command at exactly
 * that position. An answer naming an unparseable position, a position past the plan, or a command
 * the plan does not carry there cannot be reconciled with the plan the client sent, and the client
 * acts on no part of an answer it cannot reconcile.
 */
function validatedFailedBatchStep(req: DaemonWireRequest, error: DaemonError): number | undefined {
  const steps = req.flags?.batchSteps;
  const step = error.details?.step;
  const command = error.details?.command;
  if (!Array.isArray(steps) || typeof step !== 'number' || !Number.isSafeInteger(step)) {
    return undefined;
  }
  if (step < 1 || step > steps.length || typeof command !== 'string') return undefined;
  return normalizeBatchCommandName(steps[step - 1]?.command) === command ? step : undefined;
}

/**
 * Publishes one version and returns the destination, `undefined` when no record of this client
 * matches the artifact, or a typed delivery failure. A version no newer than the one published is
 * skipped. `closesRecording` says this version is the last one any later command will ask for, so
 * the failure hint offers the recovery that is actually left.
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
  if ((revision as number) <= record.revision) return { published: record.destination };
  const pending = { named: false };
  let staging: string | undefined;
  try {
    // The missing parent is created first, so this route judges the chain at the same point the local
    // writer does: the rule needs the directory the entry is really created in, which does not exist
    // until this line has run (#4565).
    await fs.promises.mkdir(path.dirname(record.destination), { recursive: true });
    const allocated = await withRecordLock(file, async () =>
      allocateStaging(file, record.destination),
    );
    staging = allocated?.staging;
    if (!staging || !allocated) return { published: undefined };
    const staged = path.join(staging, 'script.ad');
    await context.download({
      ...endpoint,
      artifactId: artifactId as string,
      destinationPath: staged,
      requestScope: req.meta,
      privateFile: { maxBytes: MAX_SCRIPT_BYTES },
    });
    const version = {
      revision: revision as number,
      staging,
      staged,
      parentIdentity: allocated.parentIdentity,
      pending,
    };
    return { published: await withRecordLock(file, async () => publishStaged(file, version)) };
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
 * Creates a staging directory beside the destination and lists it in the record before any script
 * bytes reach it, and reports the destination directory's identity so the publish can confirm it is
 * still the same one. Refuses an ancestor another local user can write (#4565), so nothing is
 * downloaded into a directory they control.
 */
function allocateStaging(
  file: string,
  destination: string,
): { staging: string; parentIdentity: string | undefined } | undefined {
  const record = readRecord(file);
  if (!record) return undefined;
  assertPrivateScriptDestination(destination);
  const directory = path.dirname(destination);
  const staging = fs.mkdtempSync(path.join(directory, '.agent-device-script-'));
  const parentIdentity = publishDirectoryIdentity(directory);
  try {
    writeRecord(file, { ...record, staging: [...(record.staging ?? []), staging] });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { staging, parentIdentity };
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
    parentIdentity: string | undefined;
    pending: { named: boolean };
  }>,
): string | undefined {
  const { revision, staging, staged, parentIdentity, pending } = version;
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
  // Re-asked here, under the record lock and right before the entry is created: whoever could write
  // an ancestor while the version was downloaded cannot move it now (#4565).
  assertPrivateScriptDestination(current.destination, parentIdentity);
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
  const refusal = scriptAncestryRefusal(error);
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

/**
 * The typed reason a destination-ancestry refusal reported (#4565), so a caller can tell an unsafe
 * destination from a download that failed. Anything else is `undefined`.
 */
function scriptAncestryRefusal(error: unknown): string | undefined {
  if (!(error instanceof AppError)) return undefined;
  const reason = error.details?.reason;
  return reason === 'script_ancestor_untrusted' || reason === 'script_ancestry_replaced'
    ? reason
    : undefined;
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
