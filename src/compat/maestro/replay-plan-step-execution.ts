import { AppError } from '../../kernel/errors.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import { isMaestroTestFailure, maestroTestFailure } from './compatibility-errors.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  resolveMaestroTimingPolicy,
} from './compatibility-policy.ts';
import type { MaestroExecutionContext } from './engine-context.ts';
import {
  checkpointMaestroCancellation,
  observationConditions,
  readIterationCount,
  resolveCommand,
  resolveNumeric,
  staticConditionMatches,
} from './engine-flow.ts';
import type { MaestroRunFlowCondition } from './program-ir.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineEvent,
  MaestroObservation,
  MaestroObservationCondition,
  MaestroRuntimeCommand,
  MaestroRuntimePort,
  MaestroRuntimeResult,
} from './engine-types.ts';
import type {
  MaestroReplayPlan,
  MaestroReplayPlanOpaqueStep,
  MaestroReplayPlanStep,
} from './replay-plan-types.ts';

export type MaestroReplayPlanExecutionState = {
  readonly plan: MaestroReplayPlan;
  readonly port: MaestroRuntimePort;
  readonly options: MaestroEngineOptions;
  readonly context: MaestroExecutionContext;
  readonly timing: ReturnType<typeof resolveMaestroTimingPolicy>;
  readonly artifacts: Set<string>;
  readonly warnings: string[];
  executed: number;
  skipped: number;
};

type PlanStepFailure = {
  readonly kind: 'maestroPlanStepFailure';
  readonly error: unknown;
  readonly source: MaestroReplayPlanStep['source'];
  readonly command?: MaestroEngineEvent['command'];
};

export async function executeMaestroReplayPlanStep(
  step: MaestroReplayPlanStep,
  state: MaestroReplayPlanExecutionState,
): Promise<MaestroRuntimeResult | undefined> {
  checkpointMaestroCancellation(state.options.signal);
  try {
    return await withStepScopes(step, state.context, async () => {
      return await executeStep(step, state);
    });
  } catch (error) {
    throw asMaestroReplayPlanStepFailure(error, step);
  }
}

async function executeStep(
  step: MaestroReplayPlanStep,
  state: MaestroReplayPlanExecutionState,
): Promise<MaestroRuntimeResult | undefined> {
  if (step.kind === 'command') {
    return await executeOptionalCommand(step.command, step.appId, state);
  }
  await executeOpaqueStep(step, state);
  return undefined;
}

async function executeOptionalCommand(
  command: MaestroRuntimeCommand,
  appId: string | undefined,
  state: MaestroReplayPlanExecutionState,
): Promise<MaestroRuntimeResult | undefined> {
  try {
    return await executeCommand(command, appId, state);
  } catch (error) {
    checkpointMaestroCancellation(state.options.signal);
    if (!isOptionalCommand(command) || !isMaestroTestFailure(error)) throw error;
    state.warnings.push(formatOptionalWarning(command, error));
    state.skipped += 1;
    return undefined;
  }
}

function formatOptionalWarning(command: MaestroRuntimeCommand, error: unknown): string {
  const source = `${command.source.path ? `${command.source.path}:` : ''}line ${command.source.line}`;
  const message = error instanceof AppError ? error.message : String(error);
  return `Optional Maestro ${command.kind} skipped at ${source}: ${message}`;
}

function isOptionalCommand(command: MaestroRuntimeCommand): boolean {
  return 'optional' in command && command.optional === true;
}

async function executeCommand(
  rawCommand: MaestroRuntimeCommand,
  appId: string | undefined,
  state: MaestroReplayPlanExecutionState,
): Promise<MaestroRuntimeResult | undefined> {
  const command = resolveCommand(rawCommand, state.context);
  switch (command.kind) {
    case 'assertVisible':
      await requireObservation(
        { kind: 'visible', selector: command.target, childOf: command.childOf },
        state.timing.assertVisibleTimeoutMs,
        state,
      );
      state.executed += 1;
      return undefined;
    case 'assertNotVisible':
      await requireObservation(
        { kind: 'notVisible', selector: command.target, childOf: command.childOf },
        state.timing.assertNotVisibleTimeoutMs,
        state,
      );
      state.executed += 1;
      return undefined;
    case 'extendedWaitUntil':
      await requireObservation(
        readExtendedWaitCondition(command),
        resolveNumeric(command.timeout, 'extendedWaitUntil.timeout') ??
          state.timing.extendedWaitUntilTimeoutMs,
        state,
      );
      state.executed += 1;
      return undefined;
    default:
      return await executeRuntimeCommand(command, appId, state);
  }
}

async function executeRuntimeCommand(
  command: MaestroRuntimeCommand,
  appId: string | undefined,
  state: MaestroReplayPlanExecutionState,
): Promise<MaestroRuntimeResult> {
  const request = stripUndefined({
    command,
    env: state.context.values,
    appId: appId === undefined ? undefined : state.context.resolve(appId),
    generation: state.context.generation,
    invalidateObservation: state.context.invalidateObservation,
    cachedObservation: state.context.observation,
    signal: state.options.signal,
  });
  const result = await state.port.execute(request);
  checkpointMaestroCancellation(state.options.signal);
  if (result.observation) state.context.recordObservation(result.observation);
  if (result.outputEnv) state.context.merge(result.outputEnv);
  result.artifactPaths?.forEach((entry) => state.artifacts.add(entry));
  state.executed += 1;
  return result;
}

async function executeOpaqueStep(
  step: MaestroReplayPlanOpaqueStep,
  state: MaestroReplayPlanExecutionState,
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
      state.executed += 1;
      for (let iteration = 0; iteration < times; iteration += 1) {
        checkpointMaestroCancellation(state.options.signal);
        await executeNestedSteps(step.body, state);
      }
      return;
    }
    case 'retry': {
      const retries = Math.min(
        readIterationCount(command.maxRetries, 1, state.context, 'retry.maxRetries'),
        MAESTRO_COMPATIBILITY_PRESETS.control.retryMaxRetries,
      );
      state.executed += 1;
      await executeRetry(step.body, retries, state);
      return;
    }
  }
}

async function executeNestedSteps(
  steps: readonly MaestroReplayPlanStep[],
  state: MaestroReplayPlanExecutionState,
): Promise<void> {
  for (const step of steps) {
    await executeMaestroReplayPlanStep(step, state);
  }
}

async function executeRetry(
  steps: readonly MaestroReplayPlanStep[],
  maxRetries: number,
  state: MaestroReplayPlanExecutionState,
): Promise<void> {
  let failure: PlanStepFailure | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    checkpointMaestroCancellation(state.options.signal);
    try {
      await executeNestedSteps(steps, state);
      return;
    } catch (error) {
      checkpointMaestroCancellation(state.options.signal);
      if (!isMaestroTestFailure(unwrapMaestroReplayPlanStepFailure(error))) throw error;
      failure = asMaestroReplayPlanStepFailure(error, steps[0]);
    }
  }
  if (failure) throw failure;
  throw new AppError('COMMAND_FAILED', 'Maestro retry commands failed.');
}

async function flowConditionMatches(
  condition: MaestroRunFlowCondition,
  state: MaestroReplayPlanExecutionState,
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
  state: MaestroReplayPlanExecutionState,
): Promise<void> {
  if (!(await observe(condition, timeoutMs, state)).matched) {
    throw maestroTestFailure(`Maestro ${condition.kind} condition did not match.`);
  }
}

async function observe(
  condition: MaestroObservationCondition,
  timeoutMs: number,
  state: MaestroReplayPlanExecutionState,
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

export function asMaestroReplayPlanStepFailure(
  error: unknown,
  step: MaestroReplayPlanStep | undefined,
): PlanStepFailure {
  if (isPlanStepFailure(error)) return error;
  const source = step?.source ?? { line: 1 };
  return {
    kind: 'maestroPlanStepFailure',
    error: withSource(error, step?.command),
    source,
    ...(step ? { command: step.command } : {}),
  };
}

function isPlanStepFailure(value: unknown): value is PlanStepFailure {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'maestroPlanStepFailure',
  );
}

export function unwrapMaestroReplayPlanStepFailure(error: unknown): unknown {
  return isPlanStepFailure(error) ? error.error : error;
}

function withSource(error: unknown, command: MaestroEngineEvent['command'] | undefined): unknown {
  if (!(error instanceof AppError) || !command || /\bline \d+\b/.test(error.message)) return error;
  const path = command.source.path ? `${command.source.path}:` : '';
  return new AppError(
    error.code,
    `${error.message} (${path}line ${command.source.line})`,
    error.details,
  );
}
