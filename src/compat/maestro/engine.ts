import { AppError } from '../../kernel/errors.ts';
import type { MaestroCommand, MaestroProgram, MaestroRunFlowCondition } from './program-ir.ts';
import { createMaestroExecutionContext, type MaestroExecutionContext } from './engine-context.ts';
import {
  checkpointMaestroCancellation,
  assertIncludePathAvailable,
  observationConditions,
  readIncludedProgram,
  readIterationCount,
  registerIncludedProgramPaths,
  resolveMaestroTimingPolicy,
  resolveCommand,
  sourcePathKey,
  staticConditionMatches,
} from './engine-flow.ts';
import type {
  MaestroEngineOptions,
  MaestroEngineResult,
  MaestroObservation,
  MaestroObservationCondition,
  MaestroRuntimeCommand,
  MaestroRuntimePort,
} from './engine-types.ts';

type EngineState = {
  port: MaestroRuntimePort;
  context: MaestroExecutionContext;
  options: MaestroEngineOptions;
  executed: number;
  skipped: number;
  artifacts: Set<string>;
  timing: ReturnType<typeof resolveMaestroTimingPolicy>;
  activeIncludePaths: Set<string>;
  appId?: string;
};

export async function executeMaestroProgram(
  program: MaestroProgram,
  port: MaestroRuntimePort,
  options: MaestroEngineOptions = {},
): Promise<MaestroEngineResult> {
  checkpointMaestroCancellation(options.signal);
  const rootPath = sourcePathKey(program.source.path);
  const state: EngineState = {
    port,
    context: createMaestroExecutionContext({}, options.env),
    options,
    executed: 0,
    skipped: 0,
    artifacts: new Set(),
    timing: resolveMaestroTimingPolicy(options.timing),
    activeIncludePaths: new Set(rootPath === undefined ? [] : [rootPath]),
  };
  await executeProgram(program, state);
  return {
    executed: state.executed,
    skipped: state.skipped,
    generation: state.context.generation,
    artifactPaths: [...state.artifacts],
  };
}

async function executeProgram(program: MaestroProgram, state: EngineState): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  const leave = state.context.enter(program.config.env);
  const previousAppId = state.appId;
  if (program.config.appId) state.appId = state.context.resolve(program.config.appId);
  try {
    await executeCommands(program.config.onFlowStart ?? [], state);
    await executeCommands(program.commands, state);
  } finally {
    try {
      if (!state.options.signal?.aborted) {
        await executeCommands(program.config.onFlowComplete ?? [], state);
      }
    } finally {
      state.appId = previousAppId;
      leave();
    }
  }
}

async function executeCommands(
  commands: readonly MaestroCommand[],
  state: EngineState,
): Promise<void> {
  for (const command of commands) {
    checkpointMaestroCancellation(state.options.signal);
    await executeObserved(command, state);
  }
}

async function executeObserved(command: MaestroCommand, state: EngineState): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  const now = state.options.now ?? Date.now;
  const startedAt = now();
  const generation = state.context.generation;
  state.options.observer?.commandStarted?.({ command, source: command.source, generation });
  try {
    await executeCommand(resolveCommand(command, state.context), state);
    checkpointMaestroCancellation(state.options.signal);
    state.options.observer?.commandCompleted?.({
      command,
      source: command.source,
      generation,
      durationMs: now() - startedAt,
    });
  } catch (error) {
    state.options.observer?.commandFailed?.({
      command,
      source: command.source,
      generation,
      durationMs: now() - startedAt,
      error,
    });
    throw withSource(error, command);
  }
}

async function executeCommand(command: MaestroCommand, state: EngineState): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  switch (command.kind) {
    case 'runFlow':
      await executeRunFlow(command, state);
      return;
    case 'repeat': {
      const times = readIterationCount(command.times, 0, state.context, 'repeat.times');
      state.executed += 1;
      for (let iteration = 0; iteration < times; iteration += 1) {
        checkpointMaestroCancellation(state.options.signal);
        await executeCommands(command.commands, state);
      }
      return;
    }
    case 'retry': {
      const retries = readIterationCount(command.maxRetries, 1, state.context, 'retry.maxRetries');
      state.executed += 1;
      await executeRetry(command.commands, retries, state);
      return;
    }
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
    case 'extendedWaitUntil': {
      const condition = readExtendedWaitCondition(command);
      await requireObservation(
        condition,
        command.timeout ?? state.timing.extendedWaitUntilTimeoutMs,
        state,
      );
      state.executed += 1;
      return;
    }
    default:
      await executeRuntimeCommand(command, state);
  }
}

async function executeRuntimeCommand(
  command: MaestroRuntimeCommand,
  state: EngineState,
): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  const request = {
    command,
    ...(state.appId ? { appId: state.appId } : {}),
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

async function executeRunFlow(
  command: Extract<MaestroCommand, { kind: 'runFlow' }>,
  state: EngineState,
): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  if (command.when && !(await flowConditionMatches(command.when, state))) {
    state.skipped += 1;
    return;
  }
  const requestedPath = assertIncludePathAvailable(command, state.activeIncludePaths);
  const program = await readIncludedProgram(command, state.options);
  checkpointMaestroCancellation(state.options.signal);
  const includedPaths = registerIncludedProgramPaths(
    command,
    program,
    requestedPath,
    state.activeIncludePaths,
  );
  const leave = state.context.enter(command.env);
  state.executed += 1;
  try {
    await executeProgram(program, state);
  } finally {
    leave();
    includedPaths.forEach((value) => state.activeIncludePaths.delete(value));
  }
}

async function flowConditionMatches(
  condition: MaestroRunFlowCondition,
  state: EngineState,
): Promise<boolean> {
  checkpointMaestroCancellation(state.options.signal);
  if (!staticConditionMatches(condition, state.context, state.options)) return false;
  for (const observation of observationConditions(condition)) {
    checkpointMaestroCancellation(state.options.signal);
    if (!(await observe(observation, state.timing.runFlowConditionTimeoutMs, state)).matched)
      return false;
  }
  return true;
}

async function requireObservation(
  condition: MaestroObservationCondition,
  timeoutMs: number,
  state: EngineState,
): Promise<void> {
  checkpointMaestroCancellation(state.options.signal);
  if (!(await observe(condition, timeoutMs, state)).matched) {
    throw new AppError('COMMAND_FAILED', `Maestro ${condition.kind} condition did not match.`);
  }
}

async function observe(
  condition: MaestroObservationCondition,
  timeoutMs: number,
  state: EngineState,
): Promise<MaestroObservation> {
  checkpointMaestroCancellation(state.options.signal);
  const request = {
    condition,
    timeoutMs,
    generation: state.context.generation,
    ...(state.context.observation ? { cachedObservation: state.context.observation } : {}),
    ...(state.options.signal ? { signal: state.options.signal } : {}),
  };
  const observation = await state.port.observe(request);
  checkpointMaestroCancellation(state.options.signal);
  state.context.recordObservation(observation);
  return observation;
}

async function executeRetry(
  commands: readonly MaestroCommand[],
  maxRetries: number,
  state: EngineState,
): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    checkpointMaestroCancellation(state.options.signal);
    try {
      await executeCommands(commands, state);
      return;
    } catch (error) {
      checkpointMaestroCancellation(state.options.signal);
      failure = error;
    }
  }
  throw failure;
}

function readExtendedWaitCondition(
  command: Extract<MaestroCommand, { kind: 'extendedWaitUntil' }>,
): MaestroObservationCondition {
  if (command.visible) return { kind: 'visible', selector: command.visible };
  if (command.notVisible) return { kind: 'notVisible', selector: command.notVisible };
  throw new AppError('INVALID_ARGS', 'Maestro extendedWaitUntil requires one condition.');
}

function withSource(error: unknown, command: MaestroCommand): unknown {
  if (!(error instanceof AppError) || /\bline \d+\b/.test(error.message)) return error;
  const path = command.source.path ? `${command.source.path}:` : '';
  return new AppError(
    error.code,
    `${error.message} (${path}line ${command.source.line})`,
    error.details,
  );
}
