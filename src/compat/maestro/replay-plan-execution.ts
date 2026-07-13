import { AppError } from '../../kernel/errors.ts';
import { createMaestroExecutionContext } from './engine-context.ts';
import { checkpointMaestroCancellation, resolveMaestroTimingPolicy } from './engine-flow.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroRuntimePort,
} from './engine-types.ts';
import type { MaestroReplayPlan } from './replay-plan-types.ts';
import {
  asMaestroReplayPlanStepFailure,
  executeMaestroReplayPlanStep,
  unwrapMaestroReplayPlanStepFailure,
  type MaestroReplayPlanExecutionState,
} from './replay-plan-step-execution.ts';

export async function executeMaestroReplayPlan(
  plan: MaestroReplayPlan,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  checkpointMaestroCancellation(options.signal);
  const startIndex = options.startIndex ?? 0;
  if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex > plan.total) {
    throw new AppError(
      'INVALID_ARGS',
      `Maestro replay startIndex ${startIndex} is out of range for a ${plan.total}-step plan.`,
    );
  }
  const state: MaestroReplayPlanExecutionState = {
    plan,
    port,
    options,
    context: createMaestroExecutionContext(
      { ...(options.defaults ?? {}), ...(options.builtins ?? {}) },
      options.env ? { ...options.env } : {},
    ),
    timing: resolveMaestroTimingPolicy(options.timing),
    artifacts: new Set(),
    executed: plan.compatibility.staticallyExecutedControls,
    skipped: plan.compatibility.staticallySkippedControls,
  };
  for (let index = startIndex; index < plan.steps.length; index += 1) {
    checkpointMaestroCancellation(options.signal);
    try {
      await executeObservedStep(plan.steps[index]!, index, state);
    } catch (error) {
      throw unwrapMaestroReplayPlanStepFailure(error);
    }
  }
  return {
    executed: state.executed,
    skipped: state.skipped,
    generation: state.context.generation,
    artifactPaths: [...state.artifacts],
  };
}

async function executeObservedStep(
  step: MaestroReplayPlanExecutionState['plan']['steps'][number],
  index: number,
  state: MaestroReplayPlanExecutionState,
): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  const now = state.options.now ?? Date.now;
  const startedAt = now();
  const generation = state.context.generation;
  const event = {
    command: step.command,
    source: step.source,
    generation,
    stepIndex: index + 1,
    stepTotal: state.plan.total,
  };
  state.options.observer?.commandStarted?.(event);
  try {
    await executeMaestroReplayPlanStep(step, state);
    checkpointMaestroCancellation(state.options.signal);
    state.options.observer?.commandCompleted?.({
      ...event,
      durationMs: now() - startedAt,
    });
  } catch (error) {
    const failure = asMaestroReplayPlanStepFailure(error, step);
    state.options.observer?.commandFailed?.({
      ...event,
      ...(failure.command ? { command: failure.command } : {}),
      source: failure.source,
      durationMs: now() - startedAt,
      error: failure.error,
      artifactPaths: [...state.artifacts],
      expandedVariables: state.context.expandedVariables,
    });
    throw failure;
  }
}
