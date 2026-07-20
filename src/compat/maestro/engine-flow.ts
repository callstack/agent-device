import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import { createRequestCanceledError } from '../../request/cancel.ts';
import type {
  MaestroCommand,
  MaestroProgram,
  MaestroRunFlowCommand,
  MaestroRunFlowCondition,
} from './program-ir.ts';
import type { MaestroExecutionContext } from './engine-context.ts';
import { evaluateMaestroBooleanExpression } from './engine-expression.ts';
import { type MaestroEngineOptions, type MaestroObservationCondition } from './engine-types.ts';

export function resolveCommand<T extends { readonly source: MaestroCommand['source'] }>(
  command: T,
  context: MaestroExecutionContext,
): T {
  return {
    ...resolveValue(command, context),
    source: command.source,
  };
}

export type ResolveNumericConstraints = {
  integer?: boolean;
  nonNegative?: boolean;
  positive?: boolean;
};

function resolveNumericDescription(constraints: ResolveNumericConstraints): string {
  if (constraints.positive) return 'a positive integer';
  if (constraints.nonNegative) return 'a non-negative integer';
  if (constraints.integer) return 'an integer';
  return 'a finite number';
}

export function resolveNumeric(
  value: number | string | undefined,
  name: string,
  constraints: ResolveNumericConstraints = {},
): number | undefined {
  if (value === undefined) return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  const description = resolveNumericDescription(constraints);
  if (!Number.isFinite(num)) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  if (constraints.integer && !Number.isInteger(num)) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  if (constraints.nonNegative && num < 0) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  if (constraints.positive && num <= 0) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  return num;
}

export function readIterationCount(
  value: number | string | undefined,
  fallback: number,
  context: MaestroExecutionContext,
  name: string,
): number {
  const resolved = value === undefined ? fallback : Number(context.resolve(String(value)));
  return resolveNumeric(resolved, name, { integer: true, nonNegative: true }) ?? fallback;
}

export function checkpointMaestroCancellation(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}

export async function readIncludedProgram(
  command: MaestroRunFlowCommand,
  options: MaestroEngineOptions,
): Promise<MaestroProgram> {
  if (command.include.kind === 'commands') {
    return {
      kind: 'program',
      source: command.source,
      config: {},
      commands: command.include.commands,
    };
  }
  if (!options.loadProgram) {
    throw new AppError('INVALID_ARGS', 'Maestro file runFlow requires a program loader.');
  }
  checkpointMaestroCancellation(options.signal);
  if (options.signal) {
    return await options.loadProgram(command.include.path, command.source.path, options.signal);
  }
  return await options.loadProgram(command.include.path, command.source.path);
}

function includePathKey(
  command: MaestroRunFlowCommand,
  parentSource: string | undefined,
): string | undefined {
  if (command.include.kind !== 'file') return undefined;
  return path.resolve(
    parentSource ? path.dirname(parentSource) : process.cwd(),
    command.include.path,
  );
}

export function sourcePathKey(source: string | undefined): string | undefined {
  return source === undefined ? undefined : path.resolve(source);
}

export function assertIncludePathAvailable(
  command: MaestroRunFlowCommand,
  activePaths: ReadonlySet<string>,
): string | undefined {
  const requestedPath = includePathKey(command, command.source.path);
  if (requestedPath && activePaths.has(requestedPath)) {
    throw new AppError('INVALID_ARGS', `Maestro runFlow cycle detected at ${requestedPath}.`);
  }
  return requestedPath;
}

export function registerIncludedProgramPaths(
  command: MaestroRunFlowCommand,
  program: MaestroProgram,
  requestedPath: string | undefined,
  activePaths: Set<string>,
): Set<string> {
  const loadedPath =
    command.include.kind === 'file' ? sourcePathKey(program.source.path) : undefined;
  const includedPaths = new Set(
    [requestedPath, loadedPath].filter((value): value is string => value !== undefined),
  );
  const repeatedPath = [...includedPaths].find((value) => activePaths.has(value));
  if (repeatedPath) {
    throw new AppError('INVALID_ARGS', `Maestro runFlow cycle detected at ${repeatedPath}.`);
  }
  includedPaths.forEach((value) => activePaths.add(value));
  return includedPaths;
}

export function staticConditionMatches(
  condition: MaestroRunFlowCondition,
  context: MaestroExecutionContext,
  options: MaestroEngineOptions,
): boolean {
  if (condition.platform && condition.platform !== options.platform) return false;
  if (condition.true === undefined) return true;
  if (typeof condition.true === 'boolean') return condition.true;
  return evaluateMaestroBooleanExpression(condition.true, context, options.platform);
}

export function observationConditions(
  condition: MaestroRunFlowCondition,
): MaestroObservationCondition[] {
  return [
    ...(condition.visible ? [{ kind: 'visible' as const, selector: condition.visible }] : []),
    ...(condition.notVisible
      ? [{ kind: 'notVisible' as const, selector: condition.notVisible }]
      : []),
  ];
}

function resolveValue<T>(value: T, context: MaestroExecutionContext): T {
  if (typeof value === 'string') return context.resolve(value) as T;
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, context)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveValue(entry, context)]),
    ) as T;
  }
  return value;
}
