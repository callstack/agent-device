import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { isRecord } from '@agent-device/kernel/record';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import type { downloadRemoteArtifact } from './daemon-artifacts.ts';
import type { SessionScriptDelivery } from './session-script-destination.ts';

/**
 * Delivers the session scripts a successful `batch` answer carries, in step order, and reports what
 * did not arrive on the batch's own payload.
 *
 * A step's `data` is what that command would have answered alone, so the session-script owner runs
 * it under its own command name: a `close` step retires this client's record, and a step that only
 * records a version leaves the record open for the next one. The batch's own payload carries the
 * version the daemon stamped after the last step, so it is delivered last — after a closing step
 * retired the record, which drops it instead of writing a stale one. The plan bound, the download
 * bound and the destination rule are `deliverSubmittedStepScripts`' and `deliverPayloadScripts`'
 * own, and the batch's answer is built from what they report.
 */
export async function deliverRemoteBatchScripts(
  endpoint: Readonly<{ baseUrl: string; token: string }>,
  req: DaemonWireRequest,
  response: Extract<DaemonResponse, { ok: true }>,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
): Promise<DaemonResponse> {
  const plan = readBatchPlan(req);
  const steps = await deliverSubmittedStepScripts(
    endpoint,
    req,
    stateDir,
    download,
    isScriptArtifact,
    plan,
    readBatchResults(response.data),
  );
  if (steps.results === undefined && steps.disclosure === undefined) return response;
  const data = {
    ...response.data,
    ...(steps.results ? { results: steps.results } : {}),
    ...withBatchDisclosure(response.data, steps.disclosure),
  };
  // The batch's own payload last: it names the newest revision, and a closing step has already
  // retired the record, so a script that arrived after the close is dropped rather than rewritten.
  const deliveredPayload = await deliverPayloadScripts(
    endpoint,
    req,
    stateDir,
    download,
    isScriptArtifact,
    { command: req.command, data, revisions: steps.revisions },
  );
  return { ok: true, data: deliveredPayload ?? data };
}

/**
 * Delivers the session scripts of one batch's successful steps, in order, and answers the delivered
 * entries plus what the batch payload must disclose.
 *
 * The plan THIS client submitted is the only authority here, never the answer: an entry must be the
 * plan's own command at the plan's own position and a step that finished. An entry that is anything
 * else is reported exactly as the daemon answered it — no download, no destination, and no
 * retirement — so a daemon cannot retire the caller record or spend the caller's downloads by naming
 * a step the caller never ran. A batch request that submitted no plan authorizes nothing at all.
 *
 * The successful steps of a FAILED batch reach this too: the runner reports them in
 * `error.details.partialResults`, and a recording a completed step closed must still reach the caller
 * file even though a later step failed. The caller keeps its own error either way.
 */
export async function deliverSubmittedStepScripts(
  endpoint: Readonly<{ baseUrl: string; token: string }>,
  req: DaemonWireRequest,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
  plan: readonly string[],
  results: ReadonlyArray<Record<string, unknown>>,
): Promise<{
  results?: Array<Record<string, unknown>>;
  disclosure?: BatchDisclosure;
  revisions: ScriptRevisions;
}> {
  const nextResults: Array<Record<string, unknown>> = [];
  const disclosure: BatchDisclosure = { warnings: [] };
  const revisions: ScriptRevisions = new Set();
  let touched = false;
  for (const [index, result] of results.entries()) {
    const plannedCommand = plan[index] ?? '';
    // An entry the plan does not authorize is reported exactly as the daemon answered it: no
    // download, no destination, and no retirement.
    if (plannedCommand === '' || !isSubmittedStep(result, plannedCommand, index)) {
      emitDiagnostic({
        level: 'warn',
        phase: 'session_script_batch_step_unauthorized',
        data: { session: req.session, step: index + 1 },
      });
      nextResults.push(result);
      continue;
    }
    const delivered = await deliverPayloadScripts(
      endpoint,
      req,
      stateDir,
      download,
      isScriptArtifact,
      {
        command: plannedCommand,
        // A copy: the session-script owner narrows the payload it is handed, and the daemon's own
        // response object stays as it arrived.
        data: isRecord(result.data) ? { ...result.data } : undefined,
        revisions,
      },
    );
    // A step's own disclosure rides the batch payload whether the daemon wrote it or this client did,
    // and whether or not the step's payload itself changed.
    collectBatchDisclosure(
      disclosure,
      isRecord(delivered) ? delivered : isRecord(result.data) ? result.data : {},
    );
    if (delivered === undefined) {
      nextResults.push(result);
      continue;
    }
    touched = true;
    nextResults.push({ ...result, data: delivered });
  }
  return {
    ...(touched ? { results: nextResults } : {}),
    ...(disclosure.warnings.length > 0 || disclosure.failure !== undefined ? { disclosure } : {}),
    revisions,
  };
}

/**
 * The commands the caller submitted, in step order. A batch request with no plan authorizes nothing:
 * with no way to tell a real step from a planted one, the answer's step entries are left alone.
 */
export function readBatchPlan(req: DaemonWireRequest): string[] {
  const steps = req.flags?.batchSteps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => normalizeStepCommand(isRecord(step) ? step.command : undefined));
}

/** The versions of this response already taken past the owner, keyed publication and revision. */
type ScriptRevisions = Set<string>;

/** What a batch's steps disclose: every step's warning text, and the first typed failure. */
type BatchDisclosure = {
  warnings: string[];
  failure?: Record<string, unknown>;
};

/**
 * Whether one answer entry is the plan's own step at the plan's own position. The runner records the
 * step's number and command on its result, so an entry must name the plan's command at that position
 * and must be a step that finished successfully.
 */
function isSubmittedStep(
  result: Record<string, unknown>,
  plannedCommand: string,
  index: number,
): boolean {
  return (
    result.step === index + 1 &&
    normalizeStepCommand(result.command) === plannedCommand &&
    result.ok === true
  );
}

function normalizeStepCommand(command: unknown): string {
  return typeof command === 'string' ? command.trim().toLowerCase() : '';
}

/**
 * Delivers one payload's session-script artifacts — a step's result or the batch's own data — or
 * answers `undefined` when there is nothing here for this client to deliver.
 *
 * The payload keeps the batch request's own endpoint, tenant and session, which is what lets it
 * reach the record that armed the recording, and takes the command name the plan gives that step,
 * which is what makes a terminal `close` retire that record. A `close` that names this client's
 * publication goes through the owner even when it carries no artifact: the daemon may have failed to
 * write the final version, and the caller still has to stop tracking a recording it no longer has.
 */
async function deliverPayloadScripts(
  endpoint: Readonly<{ baseUrl: string; token: string }>,
  req: DaemonWireRequest,
  stateDir: string,
  download: typeof downloadRemoteArtifact,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
  payload: Readonly<{
    command: string;
    data: Record<string, unknown> | undefined;
    revisions: ScriptRevisions;
  }>,
): Promise<Record<string, unknown> | undefined> {
  const data = payload.data;
  if (!data) return undefined;
  const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
  const closing = payload.command === CLOSE_COMMAND;
  const scriptCount = artifacts.filter((artifact) =>
    isScriptArtifact(artifact as DaemonArtifact),
  ).length;
  // A step's `data` is what that command would have answered on its own, so the session-script owner
  // is the only owner of `savedScript` and of the retirement a close names.
  const retires = closing && typeof data.scriptPublicationId === 'string';
  if (scriptCount === 0 && !retires) return undefined;
  const { sessionScriptDelivery } = await import('./session-script-destination.ts');
  const scripts = sessionScriptDelivery(
    endpoint,
    { ...req, command: payload.command },
    { ok: true, data },
    stateDir,
    download,
  );
  let published = data;
  await scripts.settleAfter(async () => {
    published = await publishOwnedScripts(scripts, data, isScriptArtifact, payload.revisions);
    return { ok: true, data: published };
  });
  return published === data ? undefined : published;
}

/**
 * Publishes the session-script artifacts of one payload and keeps every other artifact as the daemon
 * answered it. Only the session-script owner owns `savedScript`; a payload's other artifacts are the
 * daemon's own outputs, which the daemon already wrote on its side.
 *
 * Of several script artifacts in one payload, only the newest is delivered, and a version no newer
 * than one already taken in this response is dropped before any request. Without that, one answer
 * naming a thousand duplicate versions of one step would ask for a thousand downloads, and a version
 * older than one already published would only be refused by the owner after its bytes arrived.
 *
 * Together with the plan bound, that caps one answer at one download per submitted step whatever it
 * names, which is the budget a caller pays for one batch.
 */
async function publishOwnedScripts(
  scripts: SessionScriptDelivery,
  data: Record<string, unknown>,
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean,
  revisions: ScriptRevisions,
): Promise<Record<string, unknown>> {
  const nextData = { ...data };
  const kept: DaemonArtifact[] = [];
  const candidates: DaemonArtifact[] = [];
  const listed = Array.isArray(data.artifacts) ? (data.artifacts as DaemonArtifact[]) : [];
  for (const artifact of listed) {
    if (!isScriptArtifact(artifact)) {
      kept.push(artifact);
      continue;
    }
    if (isNewerVersion(artifact, revisions)) candidates.push(artifact);
  }
  const newest = newestScriptVersion(candidates);
  if (newest !== undefined) await scripts.publish(newest, nextData, kept);
  if (Array.isArray(data.artifacts)) nextData.artifacts = kept;
  return nextData;
}

/**
 * Whether one script artifact names a revision newer than every accepted revision of its
 * publication, claiming it for this response so a duplicate of it earns no download either.
 */
function isNewerVersion(artifact: DaemonArtifact, revisions: ScriptRevisions): boolean {
  const revision = artifact.scriptRevision;
  if (!Number.isSafeInteger(revision) || (revision as number) <= 0) return false;
  const publicationId = artifact.scriptPublicationId ?? '';
  for (const accepted of revisions) {
    if (!accepted.startsWith(`${publicationId}:`)) continue;
    if ((revision as number) <= Number(accepted.slice(publicationId.length + 1))) return false;
  }
  revisions.add(`${publicationId}:${revision}`);
  return true;
}

function newestScriptVersion(candidates: readonly DaemonArtifact[]): DaemonArtifact | undefined {
  let newest: DaemonArtifact | undefined;
  for (const candidate of candidates) {
    if (
      newest === undefined ||
      (candidate.scriptRevision as number) > (newest.scriptRevision as number)
    ) {
      newest = candidate;
    }
  }
  return newest;
}

/**
 * Lifts the steps' disclosure onto the batch payload, the channel every caller surface reads: the
 * CLI's `Warning:` lines, the MCP tool text, and `--json` and structured content all take the batch's
 * own `warnings` and `scriptDeliveryFailure`, which a step's nested data cannot reach.
 */
export function withBatchDisclosure(
  data: Record<string, unknown> | undefined,
  disclosure: BatchDisclosure | undefined,
): Record<string, unknown> {
  if (!disclosure) return {};
  const warnings = [
    ...new Set([...readResponseWarnings(data), ...disclosure.warnings].filter((w) => w !== '')),
  ];
  return {
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(disclosure.failure !== undefined ? { scriptDeliveryFailure: disclosure.failure } : {}),
  };
}

function collectBatchDisclosure(disclosure: BatchDisclosure, data: Record<string, unknown>): void {
  for (const warning of readResponseWarnings(data)) {
    if (!disclosure.warnings.includes(warning)) disclosure.warnings.push(warning);
  }
  const failure = data.scriptDeliveryFailure;
  if (disclosure.failure === undefined && isRecord(failure)) disclosure.failure = failure;
}

const CLOSE_COMMAND = 'close';

function readBatchResults(data: unknown): ReadonlyArray<Record<string, unknown>> {
  if (!isRecord(data) || !Array.isArray(data.results)) return [];
  return data.results.filter((result): result is Record<string, unknown> => isRecord(result));
}
