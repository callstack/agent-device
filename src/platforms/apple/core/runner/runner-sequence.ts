import { AppError, toAppErrorCode } from '../../../../kernel/errors.ts';
import type { RunnerCommand, RunnerSequenceStep } from './runner-contract.ts';

export const SEQUENCEABLE_RUNNER_STEP_KINDS = ['tap', 'doubleTap', 'longPress', 'drag'] as const;
export type SequenceableRunnerStepKind = (typeof SEQUENCEABLE_RUNNER_STEP_KINDS)[number];

/**
 * Hard cap on steps per `sequence` request. Two constraints set this bound:
 * - The retained journal response stays well under the 16KB cap: 20 steps x ~150B
 *   per-step result (~3-4KB worst case) leaves ample headroom for lost-response recovery.
 * - It bounds the UI-uncertainty window when a transport response is lost mid-sequence —
 *   at most 20 ordered mutating steps can have run unobserved.
 * Longer daemon-side series chunk into ceil(N/20) requests (still stop-on-failure across chunks).
 */
export const MAX_RUNNER_SEQUENCE_STEPS = 20;

// The runner clamps durationMs to 16..10000 (RunnerTests+SequenceExecution.swift), so the
// validator only guards the upper bound and finiteness; the floor is the runner's job. This keeps
// legal CLI input like `press --hold-ms 5` (holdMs min 0) acceptable instead of rejecting it here.
const MIN_DURATION_MS = 0;
const MAX_DURATION_MS = 10_000;
const MIN_PAUSE_MS = 0;
const MAX_PAUSE_MS = 10_000;

export type RunnerSequenceStepResult = {
  ok: boolean;
  kind: string;
  errorCode?: string;
  errorMessage?: string;
  gestureStartUptimeMs?: number;
  gestureEndUptimeMs?: number;
};

export type ParsedRunnerSequenceResult = {
  results: RunnerSequenceStepResult[];
  completedSteps: number;
  failedStepIndex?: number;
};

function isSequenceableKind(kind: unknown): kind is SequenceableRunnerStepKind {
  return (
    typeof kind === 'string' && (SEQUENCEABLE_RUNNER_STEP_KINDS as readonly string[]).includes(kind)
  );
}

function invalidStep(index: number, kind: unknown, message: string): AppError {
  return new AppError('INVALID_ARGS', message, {
    stepIndex: index,
    kind: typeof kind === 'string' ? kind : undefined,
  });
}

/**
 * Validates an ordered list of sequence steps before sending, throwing AppError('INVALID_ARGS')
 * naming the offending step index and kind. The runner rejects the same kinds, missing coords, and
 * over-length lists with nothing executed; durations differ — the runner clamps durationMs into
 * 16..10000 rather than rejecting, so this validator only rejects non-finite/negative/too-high
 * durations and leaves the floor to the runner's clamp.
 */
export function validateRunnerSequenceSteps(steps: RunnerSequenceStep[]): void {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new AppError('INVALID_ARGS', 'sequence requires at least one step', {
      stepCount: Array.isArray(steps) ? steps.length : 0,
    });
  }
  if (steps.length > MAX_RUNNER_SEQUENCE_STEPS) {
    throw new AppError(
      'INVALID_ARGS',
      `sequence accepts at most ${MAX_RUNNER_SEQUENCE_STEPS} steps, received ${steps.length}`,
      { stepCount: steps.length, maxSteps: MAX_RUNNER_SEQUENCE_STEPS },
    );
  }
  steps.forEach((step, index) => validateRunnerSequenceStep(step, index));
}

function validateRunnerSequenceStep(step: RunnerSequenceStep, index: number): void {
  if (!isSequenceableKind(step.kind)) {
    throw invalidStep(
      index,
      step.kind,
      `sequence step ${index} has unsupported kind "${String(step.kind)}"; allowed: ${SEQUENCEABLE_RUNNER_STEP_KINDS.join(', ')}`,
    );
  }
  if (!Number.isFinite(step.x) || !Number.isFinite(step.y)) {
    throw invalidStep(
      index,
      step.kind,
      `sequence step ${index} (${step.kind}) requires finite x and y`,
    );
  }
  if (step.kind === 'drag' && (!Number.isFinite(step.x2) || !Number.isFinite(step.y2))) {
    throw invalidStep(index, step.kind, `sequence step ${index} (drag) requires finite x2 and y2`);
  }
  if (step.durationMs !== undefined) {
    assertInRange(
      step.durationMs,
      MIN_DURATION_MS,
      MAX_DURATION_MS,
      index,
      step.kind,
      'durationMs',
    );
  }
  if (step.pauseMs !== undefined) {
    assertInRange(step.pauseMs, MIN_PAUSE_MS, MAX_PAUSE_MS, index, step.kind, 'pauseMs');
  }
}

function assertInRange(
  value: number,
  min: number,
  max: number,
  index: number,
  kind: string,
  field: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw invalidStep(
      index,
      kind,
      `sequence step ${index} (${kind}) ${field} must be between ${min} and ${max}`,
    );
  }
}

export function buildRunnerSequenceCommand(
  steps: RunnerSequenceStep[],
  appBundleId?: string,
): RunnerCommand {
  validateRunnerSequenceSteps(steps);
  return { command: 'sequence', steps, appBundleId };
}

/**
 * Single interpretation point for a `sequence` runner response. The runner returns
 * ok:true even when a step failed (step failure is data, so the tracked unit completed
 * and its results are retained for lost-response recovery). This maps a present
 * failedStepIndex into a deterministic AppError keyed off the failing step's errorCode,
 * naming the step index and kind, with completedSteps + per-step results in details.
 *
 * Any future caller issuing `sequence` MUST route the response through here, or step
 * failures will be silently ignored.
 */
export function parseRunnerSequenceResult(
  data: Record<string, unknown>,
): ParsedRunnerSequenceResult {
  const results = readSequenceResults(data.sequenceResults);
  const completedSteps =
    typeof data.completedSteps === 'number' && Number.isFinite(data.completedSteps)
      ? data.completedSteps
      : results.filter((result) => result.ok).length;
  const failedStepIndex =
    typeof data.failedStepIndex === 'number' && Number.isFinite(data.failedStepIndex)
      ? data.failedStepIndex
      : results.findIndex((result) => !result.ok) >= 0
        ? results.findIndex((result) => !result.ok)
        : undefined;

  if (failedStepIndex !== undefined) {
    throw buildSequenceStepError(results, completedSteps, failedStepIndex);
  }

  return { results, completedSteps, failedStepIndex };
}

function buildSequenceStepError(
  results: RunnerSequenceStepResult[],
  completedSteps: number,
  failedStepIndex: number,
): AppError {
  const failed = results[failedStepIndex];
  const kind = failed?.kind ?? 'step';
  const message = failed?.errorMessage ?? `sequence step ${failedStepIndex} (${kind}) failed`;
  return new AppError(toAppErrorCode(failed?.errorCode), message, {
    failedStepIndex,
    failedStepKind: kind,
    completedSteps,
    sequenceResults: results,
    hint: 'Run snapshot -i to inspect the current UI, then continue from the observed state.',
  });
}

function readSequenceResults(value: unknown): RunnerSequenceStepResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    return {
      ok: record.ok === true,
      kind: typeof record.kind === 'string' ? record.kind : 'unknown',
      errorCode: typeof record.errorCode === 'string' ? record.errorCode : undefined,
      errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
      gestureStartUptimeMs:
        typeof record.gestureStartUptimeMs === 'number' ? record.gestureStartUptimeMs : undefined,
      gestureEndUptimeMs:
        typeof record.gestureEndUptimeMs === 'number' ? record.gestureEndUptimeMs : undefined,
    };
  });
}
