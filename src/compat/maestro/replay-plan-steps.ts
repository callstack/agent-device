import { AppError } from '../../kernel/errors.ts';
import { createMaestroExecutionContext, type MaestroExecutionContext } from './engine-context.ts';
import {
  assertIncludePathAvailable,
  assertMaestroRepeatExpansionLimit,
  checkpointMaestroCancellation,
  readIncludedProgram,
  readIterationCount,
  registerIncludedProgramPaths,
  resolveCommand,
  sourcePathKey,
} from './engine-flow.ts';
import { evaluateMaestroBooleanExpression } from './engine-expression.ts';
import type { MaestroCommand, MaestroProgram, MaestroRunFlowCommand } from './program-ir.ts';
import type {
  MaestroReplayPlanCommandStep,
  MaestroReplayPlanOpaqueStep,
  MaestroReplayPlanOptions,
  MaestroReplayPlanScope,
  MaestroReplayPlanStep,
} from './replay-plan-types.ts';

type BuildState = {
  readonly options: MaestroReplayPlanOptions;
  readonly context: MaestroExecutionContext;
  readonly activeIncludePaths: Set<string>;
  staticallyExecutedControls: number;
  staticallySkippedControls: number;
};

type StaticRunFlowDecision = 'omit' | 'flatten' | 'opaque';

export type MaestroReplayPlanCompilationResult = {
  readonly steps: readonly MaestroReplayPlanStep[];
  readonly staticallyExecutedControls: number;
  readonly staticallySkippedControls: number;
};

export async function compileMaestroReplayPlanSteps(
  program: MaestroProgram,
  options: MaestroReplayPlanOptions,
): Promise<MaestroReplayPlanCompilationResult> {
  checkpointMaestroCancellation(options.signal);
  const rootPath = sourcePathKey(program.source.path);
  const state: BuildState = {
    options,
    context: createMaestroExecutionContext(options.defaults, options.env),
    activeIncludePaths: new Set(rootPath === undefined ? [] : [rootPath]),
    staticallyExecutedControls: 0,
    staticallySkippedControls: 0,
  };
  const steps = await compileProgram(program, [], undefined, program.source.path, state);
  return {
    steps,
    staticallyExecutedControls: state.staticallyExecutedControls,
    staticallySkippedControls: state.staticallySkippedControls,
  };
}

async function compileProgram(
  program: MaestroProgram,
  inheritedScopes: readonly MaestroReplayPlanScope[],
  inheritedAppId: string | undefined,
  fallbackSourcePath: string | undefined,
  state: BuildState,
): Promise<MaestroReplayPlanStep[]> {
  checkpointMaestroCancellation(state.options.signal);
  const scopes = appendScope(inheritedScopes, program.config.env);
  const appId = program.config.appId ?? inheritedAppId;
  const leave = state.context.enter(program.config.env);
  try {
    const commands = [
      ...(program.config.onFlowStart ?? []),
      ...program.commands,
      ...(program.config.onFlowComplete ?? []),
    ];
    const steps: MaestroReplayPlanStep[] = [];
    for (const command of commands) {
      steps.push(
        ...(await compileCommand(
          command,
          scopes,
          appId,
          program.source.path ?? fallbackSourcePath,
          state,
        )),
      );
    }
    return steps;
  } finally {
    leave();
  }
}

async function compileCommands(
  commands: readonly MaestroCommand[],
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
  fallbackSourcePath: string | undefined,
  state: BuildState,
): Promise<MaestroReplayPlanStep[]> {
  const steps: MaestroReplayPlanStep[] = [];
  for (const command of commands) {
    steps.push(...(await compileCommand(command, scopes, appId, fallbackSourcePath, state)));
  }
  return steps;
}

async function compileCommand(
  command: MaestroCommand,
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
  fallbackSourcePath: string | undefined,
  state: BuildState,
): Promise<MaestroReplayPlanStep[]> {
  checkpointMaestroCancellation(state.options.signal);
  const plannedCommand = withFallbackSource(command, fallbackSourcePath);
  switch (plannedCommand.kind) {
    case 'runFlow': {
      const decision = staticRunFlowDecision(plannedCommand, state);
      if (decision === 'omit') {
        state.staticallySkippedControls += 1;
        return [];
      }
      const body = await compileRunFlowBody(
        plannedCommand,
        scopes,
        appId,
        fallbackSourcePath,
        state,
      );
      if (decision === 'flatten') {
        state.staticallyExecutedControls += 1;
        return body;
      }
      return [opaqueStep(plannedCommand, scopes, appId, body)];
    }
    case 'repeat': {
      const times = staticRepeatCount(plannedCommand.times, state.context);
      if (times !== undefined) {
        assertMaestroRepeatExpansionLimit(times);
        state.staticallyExecutedControls += 1;
        const steps: MaestroReplayPlanStep[] = [];
        for (let iteration = 0; iteration < times; iteration += 1) {
          steps.push(
            ...(await compileCommands(
              plannedCommand.commands,
              scopes,
              appId,
              fallbackSourcePath,
              state,
            )),
          );
        }
        return steps;
      }
      const body = await compileCommands(
        plannedCommand.commands,
        scopes,
        appId,
        fallbackSourcePath,
        state,
      );
      return [opaqueStep(plannedCommand, scopes, appId, body)];
    }
    case 'retry': {
      const body = await compileCommands(
        plannedCommand.commands,
        scopes,
        appId,
        fallbackSourcePath,
        state,
      );
      return [opaqueStep(plannedCommand, scopes, appId, body)];
    }
    default:
      return [commandStep(plannedCommand, scopes, appId)];
  }
}

async function compileRunFlowBody(
  command: MaestroRunFlowCommand,
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
  fallbackSourcePath: string | undefined,
  state: BuildState,
): Promise<MaestroReplayPlanStep[]> {
  const resolvedCommand = resolveCommand(command, state.context);
  const requestedPath = assertIncludePathAvailable(resolvedCommand, state.activeIncludePaths);
  const program = await readIncludedProgram(resolvedCommand, state.options);
  checkpointMaestroCancellation(state.options.signal);
  const includedPaths = registerIncludedProgramPaths(
    resolvedCommand,
    program,
    requestedPath,
    state.activeIncludePaths,
  );
  const nextScopes = appendScope(scopes, command.env);
  const leave = state.context.enter(command.env);
  try {
    return await compileProgram(
      program,
      nextScopes,
      appId,
      program.source.path ?? command.source.path ?? fallbackSourcePath,
      state,
    );
  } finally {
    leave();
    includedPaths.forEach((value) => state.activeIncludePaths.delete(value));
  }
}

function staticRunFlowDecision(
  command: MaestroRunFlowCommand,
  state: BuildState,
): StaticRunFlowDecision {
  const condition = command.when;
  if (!condition) return 'flatten';
  if (condition.platform !== undefined && condition.platform !== state.options.platform) {
    return 'omit';
  }
  const booleanDecision = staticBooleanConditionDecision(condition.true, state);
  if (booleanDecision) return booleanDecision;
  if (condition.visible || condition.notVisible) return 'opaque';
  return 'flatten';
}

function staticBooleanConditionDecision(
  condition: boolean | string | undefined,
  state: BuildState,
): Extract<StaticRunFlowDecision, 'omit' | 'opaque'> | undefined {
  if (condition === false) return 'omit';
  if (typeof condition !== 'string') return undefined;
  const resolved = state.context.resolve(condition);
  if (hasUnresolvedVariable(resolved)) return 'opaque';
  return evaluateMaestroBooleanExpression(condition, state.context, state.options.platform)
    ? undefined
    : 'omit';
}

function staticRepeatCount(
  value: number | string | undefined,
  context: MaestroExecutionContext,
): number | undefined {
  if (typeof value === 'number') return readIterationCount(value, 0, context, 'repeat.times');
  if (value === undefined) return 0;
  const resolved = context.resolve(value);
  if (hasUnresolvedVariable(resolved)) return undefined;
  return readIterationCount(value, 0, context, 'repeat.times');
}

function hasUnresolvedVariable(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_.]*\}/.test(value);
}

function commandStep(
  command: Extract<MaestroReplayPlanStep['command'], { kind: string }>,
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
): MaestroReplayPlanCommandStep {
  if (command.kind === 'runFlow' || command.kind === 'repeat' || command.kind === 'retry') {
    throw new AppError('COMMAND_FAILED', `Unexpected opaque Maestro command ${command.kind}.`);
  }
  return {
    kind: 'command',
    command,
    source: command.source,
    scopes,
    ...(appId === undefined ? {} : { appId }),
  };
}

function opaqueStep(
  command: Extract<MaestroReplayPlanStep['command'], { kind: 'runFlow' | 'repeat' | 'retry' }>,
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
  body: readonly MaestroReplayPlanStep[],
): MaestroReplayPlanOpaqueStep {
  return {
    kind: 'opaque',
    command,
    source: command.source,
    scopes,
    body,
    ...(appId === undefined ? {} : { appId }),
  };
}

function appendScope(
  scopes: readonly MaestroReplayPlanScope[],
  scope: Record<string, string | number | boolean> | undefined,
): readonly MaestroReplayPlanScope[] {
  return scope === undefined ? scopes : [...scopes, scope];
}

function withFallbackSource<T extends MaestroCommand>(
  command: T,
  fallbackSourcePath: string | undefined,
): T {
  if (command.source.path || !fallbackSourcePath) return command;
  return { ...command, source: { ...command.source, path: fallbackSourcePath } } as T;
}
