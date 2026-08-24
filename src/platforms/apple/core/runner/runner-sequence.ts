import type { PressPointOptions } from '@agent-device/contracts/interactor-types';
import { pressJitter } from '@agent-device/contracts/touch-runtime';
import { isIosFamily, isTvOsDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, toAppErrorCode } from '@agent-device/kernel/errors';
import type { RunnerCommand, RunnerSequenceStep } from './runner-contract.ts';

export const SEQUENCEABLE_RUNNER_STEP_KINDS = ['tap', 'doubleTap', 'longPress'] as const;
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

/**
 * Wall-clock budget for one sequence request. The runner executes a complete chunk inside one
 * main-thread block guarded by a 30s watchdog, so chunking leaves headroom below that boundary.
 */
const RUNNER_SEQUENCE_CHUNK_BUDGET_MS = 20_000;

/** Conservative fixed allowance for synthesis, frame resolution, and XCTest dispatch. */
const RUNNER_SEQUENCE_STEP_OVERHEAD_MS = 250;

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

export async function runApplePressSeries(
  device: DeviceInfo,
  point: Readonly<{ x: number; y: number }>,
  options: PressPointOptions,
  appBundleId: string | undefined,
  runCommand: (command: RunnerCommand) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const chunks = chunkRunnerSequenceStepsByBudget(
    buildPressSteps(device, point, options),
    MAX_RUNNER_SEQUENCE_STEPS,
  );
  let first: Record<string, unknown> | undefined;
  let last: Record<string, unknown> | undefined;
  let completedSteps = 0;
  const sequenceResults: unknown[] = [];
  let stepOffset = 0;
  for (const chunk of chunks) {
    const result = await runCommand(buildRunnerSequenceCommand(chunk, appBundleId));
    first ??= result;
    last = result;
    let parsed;
    try {
      parsed = parseRunnerSequenceResult(result);
    } catch (error) {
      // The runner reports an index local to its chunk; callers need the global series index.
      throw remapSequenceErrorStepIndex(error, stepOffset);
    }
    completedSteps += parsed.completedSteps;
    sequenceResults.push(...parsed.results);
    stepOffset += chunk.length;
  }
  // Preserve the first response's acquisition frame and the last response's gesture completion.
  return {
    ...(first ?? {}),
    completedSteps,
    sequenceResults,
    ...(last?.gestureEndUptimeMs === undefined
      ? {}
      : { gestureEndUptimeMs: last.gestureEndUptimeMs }),
    timingMode: 'runner-sequence',
  };
}

/**
 * Chunks by both the runner step cap and estimated wall time so no request approaches the 30s
 * main-thread watchdog. A single over-budget step remains a one-step chunk.
 */
function chunkRunnerSequenceStepsByBudget<T extends RunnerSequenceStep>(
  steps: T[],
  maxSteps: number,
  budgetMs: number = RUNNER_SEQUENCE_CHUNK_BUDGET_MS,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let cost = 0;
  for (const step of steps) {
    const stepCost =
      (step.durationMs ?? 0) + (step.pauseMs ?? 0) + RUNNER_SEQUENCE_STEP_OVERHEAD_MS;
    if (current.length > 0 && (current.length >= maxSteps || cost + stepCost > budgetMs)) {
      chunks.push(current);
      current = [];
      cost = 0;
    }
    current.push(step);
    cost += stepCost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function buildPressSteps(
  device: DeviceInfo,
  point: Readonly<{ x: number; y: number }>,
  options: PressPointOptions,
): RunnerSequenceStep[] {
  const kind = options.doubleTap ? 'doubleTap' : options.holdMs > 0 ? 'longPress' : 'tap';
  const synthesized = kind === 'tap' && isIosFamily(device) && !isTvOsDevice(device);
  return Array.from({ length: options.count }, (_, index) => {
    const [dx, dy] = pressJitter(index, options.jitterPx);
    return {
      kind,
      x: point.x + dx,
      y: point.y + dy,
      ...(synthesized ? { synthesized: true } : {}),
      ...(options.holdMs > 0 ? { durationMs: options.holdMs } : {}),
      ...(index < options.count - 1 && options.intervalMs > 0
        ? { pauseMs: options.intervalMs }
        : {}),
    };
  });
}

function remapSequenceErrorStepIndex(error: unknown, stepOffset: number): unknown {
  if (stepOffset === 0 || !(error instanceof AppError) || !error.details) return error;
  const localIndex = error.details.failedStepIndex;
  if (typeof localIndex !== 'number') return error;
  const localCompletedSteps = error.details.completedSteps;
  return new AppError(
    error.code,
    error.message,
    {
      ...error.details,
      failedStepIndex: localIndex + stepOffset,
      chunkStepIndex: localIndex,
      ...(typeof localCompletedSteps === 'number'
        ? { completedSteps: stepOffset + localCompletedSteps }
        : {}),
    },
    error.cause,
  );
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
