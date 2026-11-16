/**
 * What a remote `batch` answer says about its steps, read from the plan THIS client submitted.
 *
 * A batch answers one entry per step, and every field of that answer is untrusted. This module holds
 * the ONE validated prefix — the steps the answer proves this caller ran, of the ONE recording this
 * client armed — and the disclosure the client answers with. Retirement, delivery and disclosure all
 * read that prefix, so none of them can act on the plan or the counts on their own.
 * `daemon-artifacts.ts` loads it only for a batch answer, because these readers pull in the command
 * registry and the response readers the client's eager module closure does not otherwise evaluate.
 */

import { normalizeBatchCommandName } from '@agent-device/command-registry/batch-policy';
import {
  readScriptDeliveryFailure,
  type DaemonArtifact,
  type ScriptDeliveryFailure,
} from '@agent-device/kernel/contracts';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { isRecord } from '@agent-device/kernel/record';

/** One plan step this answer proves ran: the entry that reports it, and whether it succeeded. */
type RanStep = Readonly<{
  data: Record<string, unknown> | undefined;
  failure?: ScriptDeliveryFailure;
  index: number;
  ok: boolean;
}>;

/**
 * Everything one `batch` answer proves about the caller's plan. `version`, `closed` and the disclosure
 * below all come from `steps`, so an answer that describes a run the caller did not submit decides
 * nothing.
 */
export type BatchAnswer = Readonly<{
  /** True when a step the answer reports as SUCCEEDED is the plan's `close` step, so the file is final. */
  closed: boolean;
  /**
   * The recording this client armed and this answer names — the newest version or failure of one of
   * its own, or its own `close`. A step of another client's recording is not ours to act on.
   */
  publicationId: string | undefined;
  /** The steps the answer proves ran, in plan order, each validated against the plan. */
  steps: readonly RanStep[];
  /** The newest version of that recording the answer names, the one this client is owed. */
  version: DaemonArtifact | undefined;
  /** Plan position the version came from: a step's index, or the batch payload's, which is LAST. */
  versionFrom: number | undefined;
}>;

/** One payload is read for at most this many of its own script artifacts. */
const MAX_SCRIPT_ARTIFACTS_PER_SOURCE = 32;

/** One batch answer is read for at most this many script artifacts in all. */
const MAX_SCRIPT_ARTIFACTS_PER_BATCH = 64;

/**
 * The plan THIS client submitted, each step named the way the daemon names a step: the runner
 * normalizes a step name before it runs it, and answers with the normalized name.
 */
function readBatchPlan(req: { flags?: Record<string, unknown> }): string[] {
  const steps = req.flags?.batchSteps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => normalizeBatchCommandName(isRecord(step) ? step.command : undefined));
}

/**
 * The failing step the runner reports, as the number of steps that had finished before it. The runner
 * reports the failing step's number, how many steps it ran, and that step's command; all three must
 * line up with the caller's own plan, so a report that does not describe a step this client ran
 * finishes nothing. A successful answer reports no failing step, so its whole plan finished.
 */
function readFinishedCount(plan: readonly string[], data: Record<string, unknown>): number {
  const { step, executed, command } = data;
  if (step === undefined && command === undefined) return plan.length;
  if (
    typeof step !== 'number' ||
    typeof executed !== 'number' ||
    !Number.isSafeInteger(step) ||
    !Number.isSafeInteger(executed) ||
    step < 1 ||
    executed < 0 ||
    step !== executed + 1 ||
    step > plan.length ||
    normalizeBatchCommandName(command) !== plan[step - 1]
  )
    return 0;
  return executed;
}

/**
 * The steps of the finished prefix the answer proves ran. Each entry must be numbered for its own
 * position and name the command the plan declares there, so the prefix ends at the first entry that
 * does not: an answer describing a different run authorizes nothing beyond it. A finished step that
 * reports a script failure still ran and succeeded as an action, and its failure is the fact the caller
 * still needs: the daemon recorded that version and could not save its own copy of it.
 */
function readRanSteps(
  results: readonly unknown[],
  plan: readonly string[],
  finished: number,
): RanStep[] {
  const steps: RanStep[] = [];
  for (let index = 0; index < finished; index += 1) {
    const result = results[index];
    if (!isRecord(result) || result.step !== index + 1) break;
    const command = normalizeBatchCommandName(result.command);
    if (command === '' || command !== plan[index]) break;
    const data = isRecord(result.data) ? result.data : undefined;
    steps.push({ data, failure: readScriptDeliveryFailure(data), index, ok: result.ok === true });
  }
  return steps;
}

/** A publication ID a response value names, when it is one. */
function readPublicationId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The newest publishable version of this client's own recording that the answer names, with the plan
 * position it came from. The batch payload is scanned FIRST — after the last step the daemon stamps its
 * newest version there — and then the validated steps in plan order. The scan is bounded per payload and
 * in all, so one answer cannot make this client read what it is not owed, and a version past a bound is
 * never inspected. Every candidate passes the publisher's own guard AND names a recording this client
 * armed: another client's revision, however high, is not a version this client can publish, and letting
 * it win this comparison would leave the caller's own file stale without saying so.
 */
function readNewestOwnedVersion(
  answer: Omit<BatchAnswer, 'version' | 'versionFrom'>,
  payloadArtifacts: readonly DaemonArtifact[],
  isPublishable: (artifact: DaemonArtifact | undefined) => boolean,
  owns: (publicationId: string) => boolean,
): { version: DaemonArtifact | undefined; versionFrom: number | undefined } {
  const sources = [payloadArtifacts, ...answer.steps.map((step) => artifactsOf(step.data))];
  const owned = boundedCandidates(sources, answer.steps.length).filter((candidate) => {
    const publicationId = readPublicationId(candidate.artifact.scriptPublicationId);
    return publicationId !== undefined && isPublishable(candidate.artifact) && owns(publicationId);
  });
  let newest: { artifact: DaemonArtifact; from: number } | undefined;
  for (const candidate of owned) {
    if (newest === undefined || revisionOf(candidate.artifact) > revisionOf(newest.artifact))
      newest = candidate;
  }
  return { version: newest?.artifact, versionFrom: newest?.from };
}

/**
 * The script artifacts one answer lists, with the plan position each came from. The batch payload is
 * scanned FIRST, and it sits past every step; a step's own version sits at that step's position. The
 * scan keeps the FIRST artifacts up to the bound — per payload and in all — so a version past a bound
 * is never inspected, exactly as the bounded read was.
 */
function boundedCandidates(
  sources: readonly (readonly DaemonArtifact[])[],
  steps: number,
): Readonly<{ artifact: DaemonArtifact; from: number }>[] {
  const candidates: { artifact: DaemonArtifact; from: number }[] = [];
  sources.forEach((list, position) => {
    const from = position === 0 ? steps : position - 1;
    const room = MAX_SCRIPT_ARTIFACTS_PER_BATCH - candidates.length;
    for (const artifact of list.slice(0, Math.min(MAX_SCRIPT_ARTIFACTS_PER_SOURCE, room))) {
      candidates.push({ artifact, from });
    }
  });
  return candidates;
}

function artifactsOf(data: Record<string, unknown> | undefined): readonly DaemonArtifact[] {
  return Array.isArray(data?.artifacts) ? (data.artifacts as DaemonArtifact[]) : [];
}

/** The revision a candidate names. `isPublishable` already rejected anything that is not a positive integer. */
function revisionOf(artifact: DaemonArtifact): number {
  return artifact.scriptRevision as number;
}

/**
 * Everything one `batch` answer proves about the plan THIS client submitted. `owns` answers whether
 * THIS client armed a recording, and is the only thing that makes a publication ID actionable.
 */
export function readBatchAnswer(
  req: { flags?: Record<string, unknown> },
  data: Record<string, unknown>,
  isPublishable: (artifact: DaemonArtifact | undefined) => boolean,
  owns: (publicationId: string) => boolean,
): BatchAnswer {
  const plan = readBatchPlan(req);
  const results = Array.isArray(data.results) ? data.results : [];
  const steps = readRanSteps(results, plan, readFinishedCount(plan, data));
  const prefix = {
    closed: steps.some((step) => step.ok && step.index === plan.indexOf('close')),
    publicationId: readOwnedPublicationId(data, steps, owns),
    steps,
  };
  return { ...prefix, ...readNewestOwnedVersion(prefix, artifactsOf(data), isPublishable, owns) };
}

/**
 * The recording this client armed that the answer names, last named first: the version or failure a
 * validated step carries, then the ID the daemon stamps on the batch payload. An ID the daemon invents
 * for a recording this client never armed owns nothing, and retires nothing.
 */
function readOwnedPublicationId(
  data: Record<string, unknown>,
  steps: readonly RanStep[],
  owns: (publicationId: string) => boolean,
): string | undefined {
  const named = [
    ...steps.flatMap((step) => [
      step.failure?.publicationId,
      readPublicationId(step.data?.scriptPublicationId),
    ]),
    readPublicationId(data.scriptPublicationId),
  ].filter((id): id is string => id !== undefined && owns(id));
  return named.at(-1);
}

/**
 * The disclosure a remote `batch` answers with: the file it wrote, the answer's own artifact list, and
 * ONE typed failure with its warning. This client's own failure about this response wins. Otherwise it
 * is the failure of the LAST validated step that belongs to THIS recording: the last step that touched
 * it is the one whose write did not land, and a step naming another recording is another delivery's
 * problem. A step failure the delivered version came from a LATER position is dropped — the file the
 * caller holds is newer than that report.
 *
 * Disclosure does not wait on a download or a retirement: a batch that delivers nothing still says why.
 * The warnings are the answer's OWN ones plus this failure's line, so a daemon-side write failure and a
 * client-side download failure are both reported. A step's nested data reaches neither the CLI's
 * `Warning:` lines nor the MCP tool text, so the failure of the step this client answers for is the one
 * named here, and a step's own warnings stay on its entry.
 */
export function readBatchDisclosure(
  data: Record<string, unknown>,
  payload: Record<string, unknown>,
  answer: BatchAnswer,
  artifacts: readonly DaemonArtifact[] | undefined,
): Record<string, unknown> | undefined {
  const own = readScriptDeliveryFailure(payload);
  const failure = own ?? readLatestStepFailure(answer);
  const disclosure: Record<string, unknown> = {
    ...(typeof payload.savedScript === 'string' ? { savedScript: payload.savedScript } : {}),
    ...(artifacts === undefined ? {} : { artifacts }),
  };
  if (failure === undefined) {
    return Object.keys(disclosure).length > 0 ? disclosure : undefined;
  }
  disclosure.scriptDeliveryFailure = failure;
  // The warnings the answer already carried stay, and this client's own report is added beside them: a
  // daemon-side write failure and a client-side download failure are two facts the caller needs.
  disclosure.warnings = [...readResponseWarnings(data), `${failure.message} ${failure.hint}`];
  return disclosure;
}

/** The last validated step that failed on this recording and that the delivered version does not supersede. */
function readSupersededStepFailure(answer: BatchAnswer): RanStep | undefined {
  const { publicationId, steps, versionFrom } = answer;
  if (publicationId === undefined) return undefined;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (step === undefined || step.failure?.publicationId !== publicationId) continue;
    // The saved version was published AFTER that step reported, so the file is newer than the report
    // and the report says nothing the caller still needs.
    return versionFrom !== undefined && versionFrom > step.index ? undefined : step;
  }
  return undefined;
}

function readLatestStepFailure(answer: BatchAnswer): ScriptDeliveryFailure | undefined {
  return readSupersededStepFailure(answer)?.failure;
}
