import { createMaestroExecutionContext, type MaestroExecutionContext } from './engine-context.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import {
  assertIncludePathAvailable,
  checkpointMaestroCancellation,
  readIncludedProgram,
  registerIncludedProgramPaths,
  sourcePathKey,
} from './engine-flow.ts';
import { evaluateMaestroBooleanExpression } from './engine-expression.ts';
import type { MaestroRuntimeCommand } from './engine-types.ts';
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
  const resolvedCommand = resolveRunFlowInclude(command, state.context);
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
  const resolved = state.context.resolveDeferred(condition);
  if (hasUnresolvedVariable(resolved)) return 'opaque';
  return evaluateMaestroBooleanExpression(condition, state.context, state.options.platform)
    ? undefined
    : 'omit';
}

function resolveRunFlowInclude(
  command: MaestroRunFlowCommand,
  context: MaestroExecutionContext,
): MaestroRunFlowCommand {
  if (command.include.kind !== 'file') return command;
  return {
    ...command,
    include: { ...command.include, path: context.resolve(command.include.path) },
  };
}

function hasUnresolvedVariable(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_.]*\}/.test(value);
}

function commandStep(
  command: MaestroRuntimeCommand,
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
): MaestroReplayPlanCommandStep {
  return stripUndefined({
    kind: 'command' as const,
    command,
    source: command.source,
    scopes,
    appId,
  });
}

function opaqueStep(
  command: Extract<MaestroCommand, { kind: 'runFlow' | 'repeat' | 'retry' }>,
  scopes: readonly MaestroReplayPlanScope[],
  appId: string | undefined,
  body: readonly MaestroReplayPlanStep[],
): MaestroReplayPlanOpaqueStep {
  return stripUndefined({
    kind: 'opaque' as const,
    command: opaqueControlCommand(command),
    source: command.source,
    scopes,
    body,
    appId,
  });
}

function opaqueControlCommand(
  command: Extract<MaestroCommand, { kind: 'runFlow' | 'repeat' | 'retry' }>,
): MaestroReplayPlanOpaqueStep['command'] {
  switch (command.kind) {
    case 'runFlow':
      return stripUndefined({
        kind: command.kind,
        source: command.source,
        when: command.when,
        label: command.label,
        ...(command.include.kind === 'file' ? { includePath: command.include.path } : {}),
      });
    case 'repeat':
      return { kind: command.kind, source: command.source, times: command.times };
    case 'retry':
      return stripUndefined({
        kind: command.kind,
        source: command.source,
        maxRetries: command.maxRetries,
      });
  }
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
