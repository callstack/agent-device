import { pressJitter } from '@agent-device/contracts/touch-runtime';
import type { PressPointOptions } from '@agent-device/contracts/interactor-types';
import { runnerSynthesizesTap, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, discloseDispatchAfterSteps } from '@agent-device/kernel/errors';
import {
  MAX_RUNNER_SEQUENCE_STEPS,
  buildRunnerSequenceCommand,
  parseRunnerSequenceResult,
  type RunnerCommand,
  type RunnerSequenceStep,
} from './runner-contract.ts';

/**
 * Wall-clock budget for one sequence request. The runner executes a complete chunk inside one
 * main-thread block guarded by a 30s watchdog, so chunking leaves headroom below that boundary.
 */
const RUNNER_SEQUENCE_CHUNK_BUDGET_MS = 20_000;

/** Conservative fixed allowance for synthesis, frame resolution, and XCTest dispatch. */
const RUNNER_SEQUENCE_STEP_OVERHEAD_MS = 250;

export async function runApplePressSeries(
  device: DeviceInfo,
  point: Readonly<{ x: number; y: number }>,
  options: PressPointOptions,
  appBundleId: string | undefined,
  runCommand: (command: RunnerCommand) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const commands = chunkRunnerSequenceStepsByBudget(
    buildPressSteps(device, point, options),
    MAX_RUNNER_SEQUENCE_STEPS,
  ).map((chunk) => buildRunnerSequenceCommand(chunk, appBundleId));
  let first: Record<string, unknown> | undefined;
  let last: Record<string, unknown> | undefined;
  let completedSteps = 0;
  const sequenceResults: unknown[] = [];
  let stepOffset = 0;
  for (const command of commands) {
    let result: Record<string, unknown>;
    try {
      result = await runCommand(command);
    } catch (error) {
      throw discloseDispatchAfterSteps(error, completedSteps);
    }
    first ??= result;
    last = result;
    let parsed;
    try {
      parsed = parseRunnerSequenceResult(result);
    } catch (error) {
      // The runner reports an index local to its chunk; callers need the global series index.
      throw discloseDispatchAfterSteps(
        remapSequenceErrorStepIndex(error, stepOffset),
        completedSteps + chunkCompletedSteps(error),
      );
    }
    completedSteps += parsed.completedSteps;
    sequenceResults.push(...parsed.results);
    stepOffset += command.steps?.length ?? 0;
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
  const synthesized = kind === 'tap' && runnerSynthesizesTap(device);
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

/** The inputs a failed chunk completed before its failing step, as the runner reported them. */
function chunkCompletedSteps(error: unknown): number {
  const completed = error instanceof AppError ? error.details?.completedSteps : undefined;
  return typeof completed === 'number' ? completed : 0;
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
