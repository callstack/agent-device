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
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { AppError } from '@agent-device/kernel/errors';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import {
  acquireProcessLock,
  confirmScriptDestination,
  openVerifiedFileForRead,
  scriptAncestryReason,
  prepareScriptDestination,
  publishFileSync,
  withProcessLock,
  type ScriptDestination,
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
type ScriptRecord = Readonly<{
  destination: string;
  force: boolean;
  revision: number;
  publishing?: Readonly<{ revision: number; file: string; staging: string }>;
  staging?: readonly string[];
  retired?: true;
}>;

/**
 * A published destination, `undefined` when no record matches, or a typed delivery failure. `repeat` marks a
 * version answered from the record alone, without looking at the file: the revision asked for, the revision the
 * record last confirmed, which is newer when the version asked for was superseded, and an interrupted save the
 * record names, which may already have replaced the file.
 */
type PublishOutcome =
  | Readonly<{
      published: string | undefined;
      repeat?: Readonly<{ requested: number; committed: number; pending?: number }>;
    }>
  | Readonly<{ failure: ScriptDeliveryFailure; error: unknown }>;

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
  data: Record<string, unknown>,
): Promise<ReceiptSettlement> {
  const { endpoint, req, stateDir } = context;
  const failures = [...(receipt.failures ?? [])];
  for (const failure of failures) discloseDeliveryFailure(data, req, failure, undefined);
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
  if (published && 'failure' in published) {
    discloseDeliveryFailure(data, req, published.failure, published.error);
  }
  const destination = published && 'published' in published ? published.published : undefined;
  if (published) noteRepeatedVersion(data, published, closesOwnPlan);
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
      noteRepeatedVersion(data, outcome, req.command === 'close');
      data.savedScript = published;
      kept.push({ ...artifact, localPath: published });
    },
    settleAfter: async (run) => {
      const data = response.data ?? {};
      if (rejected) discloseDeliveryFailure(data, req, rejected, undefined);
      settled = receipt ? await settleScriptReceipt(context, receipt, data) : undefined;
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
 * Adds a warning for a version answered from the record alone: the saved file is not looked at again, so the
 * warning names how to recover a file removed since.
 */
function noteRepeatedVersion(
  data: Record<string, unknown>,
  outcome: PublishOutcome,
  closing: boolean,
): void {
  if (!('published' in outcome) || outcome.published === undefined) return;
  const { repeat } = outcome;
  if (repeat === undefined) return;
  const recovery = closing
    ? `reuse your original open command with ${recordAgainArguments(outcome.published)}.`
    : 'while the session is still recording, the next recorded action writes the recording to the destination again.';
  data.warnings = [
    ...readResponseWarnings(data),
    `${repeatedVersionText(repeat, outcome.published)} It is not checked again. If that file is missing, ${recovery}`,
  ];
}

/**
 * The arguments that record again to the same file; a bare `--save-script` would pick a new file name. A path with a
 * C0 or C1 control character cannot survive a rendered text line, so they name a placeholder for it instead.
 */
function recordAgainArguments(destination: string): string {
  const control = (char: string) => char < ' ' || (char >= '\u007f' && char <= '\u009f');
  if ([...destination].some(control)) {
    return '--save-script=<path> --force, with the path quoted for your shell';
  }
  return `--save-script=${shellQuoteIfNeeded(destination)} --force`;
}

function repeatedVersionText(
  repeat: Readonly<{ requested: number; committed: number; pending?: number }>,
  published: string,
): string {
  const answer =
    repeat.requested === repeat.committed
      ? `Revision ${repeat.requested} of the recording was already saved to ${published}.`
      : `Revision ${repeat.requested} of the recording is superseded: the record last confirmed revision ${repeat.committed} at ${published}.`;
  return repeat.pending === undefined
    ? answer
    : `${answer} Revision ${repeat.pending} may already have replaced that file; its save was interrupted.`;
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
    data,
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
 * answered from the record: nothing is downloaded, and the saved file is neither read nor judged again.
 * `closesRecording` says this version is the last one any later command will ask for, so
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
      writeRecord(file, { ...withoutPublishing(record), retired: true });
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
 * while it was read through one verified descriptor; anything else is not committed. Nothing is stored.
 */
function verifiedStagedIdentity(staged: string): string {
  const descriptor = openVerifiedFileForRead(staged);
  if (descriptor === undefined) throw new Error('The staged script is missing.');
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
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

function withoutPublishing(record: ScriptRecord): ScriptRecord {
  const { publishing: _interrupted, ...rest } = record;
  return rest;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const record = parsed as Partial<Record<keyof ScriptRecord, unknown>>;
  const valid =
    typeof record.destination === 'string' &&
    typeof record.force === 'boolean' &&
    Number.isSafeInteger(record.revision) &&
    (record.publishing === undefined || isPublishing(record.publishing)) &&
    (record.retired === undefined || record.retired === true) &&
    (record.staging === undefined ||
      (Array.isArray(record.staging) &&
        record.staging.every((staging) => typeof staging === 'string')));
  if (!valid) return undefined;
  // A digest an earlier version of this client kept is dropped, so the next write does not carry it forward.
  const {
    committedDigest: _digest,
    entry: _entry,
    ...current
  } = record as ScriptRecord & { committedDigest?: unknown; entry?: unknown };
  return current;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPublishing(publishing: unknown): boolean {
  return (
    isObject(publishing) &&
    Number.isSafeInteger(publishing.revision) &&
    typeof publishing.file === 'string' &&
    typeof publishing.staging === 'string'
  );
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
