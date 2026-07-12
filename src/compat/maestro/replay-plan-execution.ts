import { AppError } from '../../kernel/errors.ts';
import { createMaestroExecutionContext, type MaestroExecutionContext } from './engine-context.ts';
import {
  assertMaestroRepeatExpansionLimit,
  checkpointMaestroCancellation,
  observationConditions,
  readIterationCount,
  resolveCommand,
  resolveMaestroTimingPolicy,
  staticConditionMatches,
} from './engine-flow.ts';
import type { MaestroCommand, MaestroRunFlowCondition } from './program-ir.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroObservation,
  MaestroObservationCondition,
  MaestroRuntimeCommand,
  MaestroRuntimePort,
} from './engine-types.ts';
import type {
  MaestroReplayPlan,
  MaestroReplayPlanOpaqueStep,
  MaestroReplayPlanStep,
} from './replay-plan-types.ts';

type PlanState = {
  readonly plan: MaestroReplayPlan;
  readonly port: MaestroRuntimePort;
  readonly options: MaestroEngineOptions;
  readonly context: MaestroExecutionContext;
  readonly timing: ReturnType<typeof resolveMaestroTimingPolicy>;
  readonly artifacts: Set<string>;
  executed: number;
  skipped: number;
};

type PlanStepFailure = {
  readonly kind: 'maestroPlanStepFailure';
  readonly error: unknown;
  readonly source: MaestroReplayPlanStep['source'];
};

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
  const state: PlanState = {
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
      throw unwrapPlanStepFailure(error);
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
  step: MaestroReplayPlanStep,
  index: number,
  state: PlanState,
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
    await executeStepWithFailure(step, state);
    checkpointMaestroCancellation(state.options.signal);
    state.options.observer?.commandCompleted?.({
      ...event,
      durationMs: now() - startedAt,
    });
  } catch (error) {
    const failure = asPlanStepFailure(error, step);
    state.options.observer?.commandFailed?.({
      ...event,
      source: failure.source,
      durationMs: now() - startedAt,
      error: failure.error,
    });
    throw failure;
  }
}

async function executeStepWithFailure(
  step: MaestroReplayPlanStep,
  state: PlanState,
): Promise<void> {
  try {
    await withStepScopes(step, state.context, async () => {
      await executeStep(step, state);
    });
  } catch (error) {
    throw asPlanStepFailure(error, step);
  }
}

async function executeStep(step: MaestroReplayPlanStep, state: PlanState): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  if (step.kind === 'command') {
    await executeCommand(step.command, step.appId, state);
    return;
  }
  await executeOpaqueStep(step, state);
}

async function executeCommand(
  rawCommand: MaestroRuntimeCommand,
  appId: string | undefined,
  state: PlanState,
): Promise<void> {
  const command = resolveCommand(rawCommand, state.context);
  switch (command.kind) {
    case 'assertVisible':
      await requireObservation(
        { kind: 'visible', selector: command.target },
        state.timing.assertVisibleTimeoutMs,
        state,
      );
      state.executed += 1;
      return;
    case 'assertNotVisible':
      await requireObservation(
        { kind: 'notVisible', selector: command.target },
        state.timing.assertNotVisibleTimeoutMs,
        state,
      );
      state.executed += 1;
      return;
    case 'extendedWaitUntil':
      await requireObservation(
        readExtendedWaitCondition(command),
        command.timeout ?? state.timing.extendedWaitUntilTimeoutMs,
        state,
      );
      state.executed += 1;
      return;
    default:
      await executeRuntimeCommand(command, appId, state);
  }
}

async function executeRuntimeCommand(
  command: MaestroRuntimeCommand,
  appId: string | undefined,
  state: PlanState,
): Promise<void> {
  const request = {
    command,
    env: state.context.values,
    ...(appId === undefined ? {} : { appId: state.context.resolve(appId) }),
    generation: state.context.generation,
    ...(state.context.observation ? { cachedObservation: state.context.observation } : {}),
    ...(state.options.signal ? { signal: state.options.signal } : {}),
  };
  const result = await state.port.execute(request);
  checkpointMaestroCancellation(state.options.signal);
  if (result.observation) state.context.recordObservation(result.observation);
  if (result.outputEnv) state.context.merge(result.outputEnv);
  result.artifactPaths?.forEach((entry) => state.artifacts.add(entry));
  if (result.mutated) state.context.recordMutation();
  state.executed += 1;
}

async function executeOpaqueStep(
  step: MaestroReplayPlanOpaqueStep,
  state: PlanState,
): Promise<void> {
  const command = resolveCommand(step.command, state.context);
  switch (command.kind) {
    case 'runFlow':
      if (command.when && !(await flowConditionMatches(command.when, state))) {
        state.skipped += 1;
        return;
      }
      state.executed += 1;
      await executeNestedSteps(step.body, state);
      return;
    case 'repeat': {
      const times = readIterationCount(command.times, 0, state.context, 'repeat.times');
      assertMaestroRepeatExpansionLimit(times);
      state.executed += 1;
      for (let iteration = 0; iteration < times; iteration += 1) {
        checkpointMaestroCancellation(state.options.signal);
        await executeNestedSteps(step.body, state);
      }
      return;
    }
    case 'retry': {
      const retries = readIterationCount(command.maxRetries, 1, state.context, 'retry.maxRetries');
      state.executed += 1;
      await executeRetry(step.body, retries, state);
      return;
    }
  }
}

async function executeNestedSteps(
  steps: readonly MaestroReplayPlanStep[],
  state: PlanState,
): Promise<void> {
  for (const step of steps) {
    checkpointMaestroCancellation(state.options.signal);
    await executeStepWithFailure(step, state);
  }
}

async function executeRetry(
  steps: readonly MaestroReplayPlanStep[],
  maxRetries: number,
  state: PlanState,
): Promise<void> {
  let failure: PlanStepFailure | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    checkpointMaestroCancellation(state.options.signal);
    try {
      await executeNestedSteps(steps, state);
      return;
    } catch (error) {
      checkpointMaestroCancellation(state.options.signal);
      failure = asPlanStepFailure(error, steps[0]);
    }
  }
  if (failure) throw failure;
  throw new AppError('COMMAND_FAILED', 'Maestro retry commands failed.');
}

async function flowConditionMatches(
  condition: MaestroRunFlowCondition,
  state: PlanState,
): Promise<boolean> {
  if (!staticConditionMatches(condition, state.context, state.options)) return false;
  for (const observation of observationConditions(condition)) {
    checkpointMaestroCancellation(state.options.signal);
    if (!(await observe(observation, state.timing.runFlowConditionTimeoutMs, state)).matched) {
      return false;
    }
  }
  return true;
}

async function requireObservation(
  condition: MaestroObservationCondition,
  timeoutMs: number,
  state: PlanState,
): Promise<void> {
  if (!(await observe(condition, timeoutMs, state)).matched) {
    throw new AppError('COMMAND_FAILED', `Maestro ${condition.kind} condition did not match.`);
  }
}

async function observe(
  condition: MaestroObservationCondition,
  timeoutMs: number,
  state: PlanState,
): Promise<MaestroObservation> {
  const request = {
    condition,
    timeoutMs,
    generation: state.context.generation,
    env: state.context.values,
    ...(state.context.observation ? { cachedObservation: state.context.observation } : {}),
    ...(state.options.signal ? { signal: state.options.signal } : {}),
  };
  const observation = await state.port.observe(request);
  checkpointMaestroCancellation(state.options.signal);
  state.context.recordObservation(observation);
  return observation;
}

function readExtendedWaitCondition(
  command: Extract<MaestroRuntimeCommand, { kind: 'extendedWaitUntil' }>,
): MaestroObservationCondition {
  if (command.visible) return { kind: 'visible', selector: command.visible };
  if (command.notVisible) return { kind: 'notVisible', selector: command.notVisible };
  throw new AppError('INVALID_ARGS', 'Maestro extendedWaitUntil requires one condition.');
}

async function withStepScopes<T>(
  step: MaestroReplayPlanStep,
  context: MaestroExecutionContext,
  callback: () => Promise<T>,
): Promise<T> {
  const leaves = step.scopes.map((scope) => context.enter({ ...scope }));
  try {
    return await callback();
  } finally {
    for (let index = leaves.length - 1; index >= 0; index -= 1) leaves[index]!();
  }
}

function asPlanStepFailure(
  error: unknown,
  step: MaestroReplayPlanStep | undefined,
): PlanStepFailure {
  if (isPlanStepFailure(error)) return error;
  const source = step?.source ?? { line: 1 };
  return {
    kind: 'maestroPlanStepFailure',
    error: withSource(error, step?.command),
    source,
  };
}

function isPlanStepFailure(value: unknown): value is PlanStepFailure {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'maestroPlanStepFailure',
  );
}

function unwrapPlanStepFailure(error: unknown): unknown {
  return isPlanStepFailure(error) ? error.error : error;
}

function withSource(error: unknown, command: MaestroCommand | undefined): unknown {
  if (!(error instanceof AppError) || !command || /\bline \d+\b/.test(error.message)) return error;
  const path = command.source.path ? `${command.source.path}:` : '';
  return new AppError(
    error.code,
    `${error.message} (${path}line ${command.source.line})`,
    error.details,
  );
}
