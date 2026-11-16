/**
 * What a remote `batch` answer says about its steps, read from the plan THIS client submitted.
 *
 * A batch answers one entry per step, and every field of that answer is untrusted. This module holds
 * the readers that decide what the caller is owed: which steps finished, which script version is the
 * newest of them, and which report the client has to disclose. `daemon-artifacts.ts` loads it only for
 * a batch answer, because these readers pull in the command registry and the response readers the
 * client's eager module closure does not otherwise evaluate.
 */

import { normalizeBatchCommandName } from '@agent-device/command-registry/batch-policy';
import {
  readScriptDeliveryFailure,
  type DaemonArtifact,
  type ScriptDeliveryFailure,
} from '@agent-device/kernel/contracts';
import { readResponseWarnings } from '@agent-device/kernel/success-text';
import { isRecord } from '@agent-device/kernel/record';

/** One finished plan step: the payload the daemon answered for it, and the failure it reports. */
export type BatchFinishedStep = Readonly<{
  data: Record<string, unknown> | undefined;
  failure?: ScriptDeliveryFailure;
}>;

/**
 * The plan THIS client submitted, each step named the way the daemon names a step: the runner
 * normalizes a step name before it runs it, and answers with the normalized name.
 */
export function readBatchPlan(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => normalizeBatchCommandName(isRecord(step) ? step.command : undefined));
}

/**
 * How many steps had finished before a failure: the steps before the one the error names. The runner
 * reports the failing step's number, how many steps it ran, and that step's command; all three must
 * line up with the caller's own plan, so a report that does not describe a step this client ran
 * finishes nothing, and no step entry can then authorize a download or a retirement.
 */
export function readFinishedStepCount(
  plan: readonly string[],
  failure: Record<string, unknown>,
): number {
  const { step, executed, command } = failure;
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

/** The plan's own finished steps, in plan order: each entry must name that step and be a step that finished. */
export function readFinishedSteps(
  results: readonly unknown[],
  plan: readonly string[],
  finished: number,
): BatchFinishedStep[] {
  const steps: BatchFinishedStep[] = [];
  for (let index = 0; index < finished; index += 1) {
    const result = results[index];
    if (!isRecord(result) || result.ok !== true || result.step !== index + 1) continue;
    const command = normalizeBatchCommandName(result.command);
    if (command === '' || command !== plan[index]) continue;
    const data = isRecord(result.data) ? result.data : undefined;
    steps.push({ data, failure: readScriptDeliveryFailure(data) });
  }
  return steps;
}

/**
 * Whether the finished part of the plan ran the step that ends the recording: a close the caller never
 * submitted, or never finished, leaves the recording open and the caller's record in place.
 */
export function readFinishedClose(plan: readonly string[], finished: number): boolean {
  return plan.slice(0, finished).includes('close');
}

/**
 * What one delivery discloses on the batch payload: the file it wrote, the answer's own artifact list,
 * and ONE typed failure with the warning paired to it. This client's own failure wins; otherwise it is
 * the last failure a finished step reported for this recording, unless the version this client saved
 * came from a step AFTER the one that reported it. A step's nested data reaches neither the CLI's
 * `Warning:` lines nor the MCP tool text, and a warning belonging to another report stays on its step.
 */
export function readBatchDisclosure(
  payload: Record<string, unknown>,
  steps: readonly BatchFinishedStep[],
  deliveredFrom: number | undefined,
  publication: string | undefined,
  artifacts: DaemonArtifact[] | undefined,
): Record<string, unknown> | undefined {
  // The LAST finished step that reports a failure of THIS recording, in plan order.
  let reported: BatchFinishedStep | undefined;
  let reportedAt = -1;
  steps.forEach((step, index) => {
    if (step.failure !== undefined && step.failure.publicationId === publication) {
      reported = step;
      reportedAt = index;
    }
  });
  // The version this client saved was published AFTER that step reported its failure, so the file is
  // newer than the report and the report says nothing the caller still needs.
  const superseded = deliveredFrom !== undefined && deliveredFrom > reportedAt;
  const own = readScriptDeliveryFailure(payload);
  const failure = own ?? (superseded ? undefined : reported?.failure);
  const disclosure: Record<string, unknown> = {};
  if (typeof payload.savedScript === 'string') disclosure.savedScript = payload.savedScript;
  if (artifacts !== undefined) disclosure.artifacts = artifacts;
  if (failure === undefined) return Object.keys(disclosure).length > 0 ? disclosure : undefined;
  const source = own === undefined && reported !== undefined ? reported.data : payload;
  disclosure.scriptDeliveryFailure = failure;
  // Only the warning written beside this failure rides up, never every step's warnings.
  const paired = readResponseWarnings(source).filter(
    (warning) => warning.includes(failure.message) || warning.includes(failure.hint),
  );
  disclosure.warnings = paired.length > 0 ? paired : [`${failure.message} ${failure.hint}`];
  return disclosure;
}
