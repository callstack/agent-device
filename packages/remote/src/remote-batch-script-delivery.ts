import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonArtifact, DaemonResponse } from '@agent-device/kernel/contracts';
import { isRecord } from '@agent-device/kernel/record';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import type { downloadRemoteArtifact } from './daemon-artifacts.ts';

/**
 * Delivers the session script a remote `batch` answer carries: AT MOST ONE version, the newest one
 * this client's plan authorizes, wherever the answer names it — in a finished step's result or on the
 * batch payload itself.
 *
 * Every version is the whole recording from the `open`, so an older one is worth nothing and one batch
 * never owes more than a single download. The batch's outcome is not changed here: a successful batch
 * stays successful, a failed one keeps its own error, and a version that cannot be saved is reported
 * the same way a single response reports it.
 *
 * The plan THIS client submitted is the only authority, never the answer. A step the caller never ran,
 * or never finished, authorizes no download and no retirement, and a batch request that submitted no
 * plan authorizes nothing at all.
 */
export async function deliverRemoteBatchScripts(
  context: DeliveryContext,
  response: Extract<DaemonResponse, { ok: true }>,
): Promise<DaemonResponse> {
  const data = isRecord(response.data) ? response.data : {};
  const plan = readBatchPlan(context.req);
  const disclosure = await deliverBatchScript(context, plan, data, plan.length);
  return disclosure === undefined
    ? response
    : { ok: true, data: { ...data, ...withBatchDisclosure(data, disclosure) } };
}

/**
 * Delivers the session script of the steps a FAILED remote `batch` had completed, and answers the
 * fields its error should disclose about that delivery.
 *
 * The runner reports the finished steps in the error's `details.partialResults`, so a recording that an
 * earlier step closed would be lost just because a later step failed. The completed prefix is derived
 * from the plan and cross-checked against the step the error names, so entries for steps at or after
 * the failure — which the runner never produces — authorize neither a download nor the retirement of
 * the caller's record.
 */
export async function deliverSubmittedStepScripts(
  context: DeliveryContext,
  plan: readonly string[],
  details: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
  return await deliverBatchScript(
    context,
    plan,
    { results: details?.partialResults },
    readCompletedStepCount(plan, details),
  );
}

/** What it takes to deliver one batch's script: this client's own endpoint, request and file owner. */
export type DeliveryContext = Readonly<{
  endpoint: Readonly<{ baseUrl: string; token: string }>;
  req: DaemonWireRequest;
  stateDir: string;
  download: typeof downloadRemoteArtifact;
  isScriptArtifact: (artifact: DaemonArtifact | undefined) => boolean;
}>;

/**
 * The commands the caller submitted, in step order. A batch request with no plan authorizes nothing:
 * with no way to tell a real step from a planted one, the answer is left alone.
 */
export function readBatchPlan(req: DaemonWireRequest): string[] {
  const steps = req.flags?.batchSteps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => normalizeStepCommand(isRecord(step) ? step.command : undefined));
}

/**
 * How many of the caller's steps had finished before a failure. The runner reports both the failing
 * step's number and the number of steps it executed; the two must agree on one boundary before any
 * step entry counts as finished, so a report that does not describe a step this client ran authorizes
 * nothing.
 */
function readCompletedStepCount(
  plan: readonly string[],
  failure: Record<string, unknown> | undefined,
): number {
  if (failure === undefined) return plan.length;
  const step = failure.step;
  const executed = failure.executed;
  if (
    typeof step !== 'number' ||
    typeof executed !== 'number' ||
    !Number.isSafeInteger(step) ||
    !Number.isSafeInteger(executed) ||
    step < 1 ||
    executed < 0 ||
    step !== executed + 1
  )
    return 0;
  return Math.min(executed, plan.length);
}

/** One plan step this client ran and finished, with the payload the daemon answered for it. */
type FinishedStep = Readonly<{ command: string; data: Record<string, unknown> | undefined }>;

/**
 * The plan's own finished steps within the completed prefix, in plan order. Only the prefix is read, so
 * the work is bounded by the plan the caller submitted rather than by what the answer carries. An entry
 * that is not the plan's own command at the plan's own position, or that did not finish, is not
 * authorized and is never read for a script.
 */
function readFinishedSteps(
  data: Record<string, unknown>,
  plan: readonly string[],
  completed: number,
): FinishedStep[] {
  const results = Array.isArray(data.results) ? data.results : [];
  const finished: FinishedStep[] = [];
  for (let index = 0; index < completed; index += 1) {
    const command = plan[index] ?? '';
    const result = results[index];
    if (isFinishedStep(result, command, index))
      finished.push({ command, data: isRecord(result.data) ? result.data : undefined });
  }
  return finished;
}

function isFinishedStep(
  result: unknown,
  plannedCommand: string,
  index: number,
): result is Record<string, unknown> {
  return (
    plannedCommand !== '' &&
    isRecord(result) &&
    result.step === index + 1 &&
    result.ok === true &&
    normalizeStepCommand(result.command) === plannedCommand
  );
}

/**
 * Delivers the newest version this batch is owed, or answers `undefined` when it is owed none.
 *
 * The session-script owner stays the only owner of `savedScript`, of the destination rule and of the
 * retirement, and it is handed a payload of its own rather than the caller's response: the batch's
 * payload is the daemon's answer, and what the delivery produced is merged onto it afterwards. The
 * owner is asked under `close` when the plan ran a close, which is what lets it publish the final
 * version and then retire this client's record exactly as a single `close` response does — including
 * when the close carried no version, because the daemon may have failed to write it and the caller
 * still has to stop tracking a recording it no longer has.
 */
async function deliverBatchScript(
  context: DeliveryContext,
  plan: readonly string[],
  data: Record<string, unknown>,
  completed: number,
): Promise<Record<string, unknown> | undefined> {
  if (plan.length === 0 || completed < 1) return undefined;
  const steps = readFinishedSteps(data, plan, completed);
  const closing = steps.some((step) => step.command === CLOSE_COMMAND);
  const versions = readScriptVersions(context, steps, data);
  const publicationId = openPublicationId(steps, data, versions);
  // Retirement follows the PLAN alone: a close this client ran and finished, and no field an answer
  // carries. The owner finds this client's record by hashing the ID with its own endpoint, tenant and
  // session, so an ID the daemon invents matches no record and retires nothing.
  const retires = closing && typeof publicationId === 'string';
  const newest = newestScriptVersion(versions, publicationId);
  if (newest === undefined && !retires) return undefined;
  const { sessionScriptDelivery } = await import('./session-script-destination.ts');
  const payload: Record<string, unknown> = {};
  if (typeof publicationId === 'string') payload.scriptPublicationId = publicationId;
  const scripts = sessionScriptDelivery(
    context.endpoint,
    { ...context.req, command: closing ? CLOSE_COMMAND : context.req.command },
    { ok: true, data: payload },
    context.stateDir,
    context.download,
  );
  await scripts.settleAfter(async () => {
    if (newest !== undefined) await scripts.publish(newest, payload, []);
    return { ok: true, data: payload };
  });
  return disclosedDelivery(payload, steps);
}

/**
 * Every session-script version this batch's answer carries, from the plan's finished steps AND the
 * batch's own payload: a step may publish as it goes, and the daemon may stamp its newest version on
 * the batch payload after the last step, so both are read whatever the other one holds.
 *
 * One linear scan, bounded by MAX_SCRIPT_ARTIFACTS_PER_ENTRY artifacts per payload and
 * MAX_SCRIPT_ARTIFACTS_PER_BATCH in total, so the cost stays bounded whatever an answer names. Each
 * candidate must satisfy the same guards the publisher uses, so nothing this module cannot name is ever
 * interpolated into a record lookup, a path, or a download request.
 */
function readScriptVersions(
  context: DeliveryContext,
  steps: readonly FinishedStep[],
  data: Record<string, unknown>,
): DaemonArtifact[] {
  const versions: DaemonArtifact[] = [];
  let scanned = 0;
  // The batch's own payload is read first: the daemon stamps its newest version there after the last
  // step, so the bound below keeps the version the caller is owed even by a crowded answer.
  for (const payload of [data, ...steps.map((step) => step.data)]) {
    const artifacts = Array.isArray(payload?.artifacts)
      ? (payload.artifacts as DaemonArtifact[])
      : [];
    for (const artifact of artifacts.slice(0, MAX_SCRIPT_ARTIFACTS_PER_ENTRY)) {
      if (scanned >= MAX_SCRIPT_ARTIFACTS_PER_BATCH) return versions;
      scanned += 1;
      if (context.isScriptArtifact(artifact) && isUsableVersion(artifact)) versions.push(artifact);
    }
  }
  return versions;
}

/**
 * The publication this batch records, taken in order of authority: the ID the plan's own finished
 * `close` step names, then the ID the first finished step names, then the ID the batch payload echoes,
 * then the ID of the newest version the answer carries. Only versions of that one publication are
 * delivered, and only a publication THIS client recorded can ever be published, so an ID the daemon
 * invents costs no download and retires nothing.
 */
function openPublicationId(
  steps: readonly FinishedStep[],
  data: Record<string, unknown>,
  versions: readonly DaemonArtifact[],
): string | undefined {
  return [
    steps.find((step) => step.command === CLOSE_COMMAND)?.data?.scriptPublicationId,
    steps.find((step) => typeof step.data?.scriptPublicationId === 'string')?.data
      ?.scriptPublicationId,
    data.scriptPublicationId,
    newestScriptVersion(versions, undefined)?.scriptPublicationId,
  ].find((id): id is string => typeof id === 'string');
}

/**
 * The newest version of the open publication, or `undefined` when `publicationId` is not given and the
 * newest version of any publication is wanted. Every version is the whole recording, so an older one is
 * the same file with less of it: keeping only the newest is what makes one answer that names a thousand
 * versions of one step, or of several steps, cost ONE download instead of a thousand.
 */
function newestScriptVersion(
  versions: readonly DaemonArtifact[],
  publicationId: string | undefined,
): DaemonArtifact | undefined {
  let newest: DaemonArtifact | undefined;
  for (const version of versions) {
    if (publicationId !== undefined && version.scriptPublicationId !== publicationId) continue;
    if (
      newest === undefined ||
      (version.scriptRevision as number) > (newest.scriptRevision as number)
    )
      newest = version;
  }
  return newest;
}

/**
 * Whether one artifact names a version the publisher can act on: the guards `publishScriptVersion`
 * uses. A malformed ID, revision or artifact ID is dropped here rather than reaching a record lookup, a
 * download request, or an error message, and the response's own bytes never become a path component.
 */
function isUsableVersion(artifact: DaemonArtifact): boolean {
  const revision = artifact.scriptRevision;
  return (
    artifact.field === 'savedScript' &&
    typeof artifact.scriptPublicationId === 'string' &&
    typeof artifact.artifactId === 'string' &&
    Number.isSafeInteger(revision) &&
    (revision as number) > 0
  );
}

/**
 * What one delivery and the plan's finished steps disclose on the caller's payload: the file that was
 * written, and every script warning — the typed failure and its warning from this client's own
 * delivery, and what the daemon disclosed on a step. A step's nested data reaches neither the CLI's
 * `Warning:` lines nor the MCP tool text, so anything the caller has to see is lifted here. The
 * daemon's answer itself is left intact.
 */
function disclosedDelivery(
  payload: Record<string, unknown>,
  steps: readonly FinishedStep[],
): Record<string, unknown> | undefined {
  const failure = payload.scriptDeliveryFailure;
  const disclosure: Record<string, unknown> = {};
  if (payload.savedScript !== undefined) disclosure.savedScript = payload.savedScript;
  if (isRecord(failure)) disclosure.scriptDeliveryFailure = failure;
  const warnings = [
    ...new Set([
      ...readResponseWarnings(payload),
      ...steps.flatMap((step) => readResponseWarnings(step.data)),
    ]),
  ].filter((warning) => warning !== '');
  if (warnings.length > 0) disclosure.warnings = warnings;
  return Object.keys(disclosure).length > 0 ? disclosure : undefined;
}

/**
 * Lifts a batch's script disclosure onto the payload every caller surface reads: the CLI's `Warning:`
 * lines, the MCP tool text, and `--json` and structured content all take the batch's own `warnings` and
 * `scriptDeliveryFailure`, which a step's nested data cannot reach.
 */
export function withBatchDisclosure(
  data: Record<string, unknown> | undefined,
  disclosure: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!disclosure) return {};
  const warnings = [
    ...new Set([...readResponseWarnings(data), ...readResponseWarnings(disclosure)]),
  ].filter((warning) => warning !== '');
  return {
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(disclosure.scriptDeliveryFailure !== undefined
      ? { scriptDeliveryFailure: disclosure.scriptDeliveryFailure }
      : {}),
    ...(disclosure.savedScript !== undefined ? { savedScript: disclosure.savedScript } : {}),
  };
}

function normalizeStepCommand(command: unknown): string {
  return typeof command === 'string' ? command.trim().toLowerCase() : '';
}

const CLOSE_COMMAND = 'close';

/** One payload is read for at most this many of its own script artifacts. */
const MAX_SCRIPT_ARTIFACTS_PER_ENTRY = 32;

/** One batch answer is read for at most this many script artifacts in total, across every payload. */
const MAX_SCRIPT_ARTIFACTS_PER_BATCH = 64;
