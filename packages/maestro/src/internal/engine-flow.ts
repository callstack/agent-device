import path from 'node:path';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  MAESTRO_NUMERIC_FIELD_CONSTRAINTS,
  numericDescription,
  type NumericScalarConstraints,
} from './program-ir-values.ts';
import type {
  MaestroCommand,
  MaestroProgram,
  MaestroRunFlowCommand,
  MaestroRunFlowCondition,
} from './program-ir.ts';
import type { MaestroExecutionContext } from './engine-context.ts';
import { tryEvaluateMaestroBooleanExpression } from './engine-expression.ts';
import { isMaestroConditionTruthy, isMaestroScriptResultTruthy } from './engine-truthiness.ts';
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

export function resolveNumeric(
  value: number | string | undefined,
  name: string,
  constraints?: NumericScalarConstraints,
): number | undefined {
  if (value === undefined) return undefined;
  const effectiveConstraints = constraints ?? MAESTRO_NUMERIC_FIELD_CONSTRAINTS[name] ?? {};
  const description = numericDescription(effectiveConstraints);
  let num: number;
  if (typeof value === 'number') {
    num = value;
  } else {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
    }
    num = Number(trimmed);
  }
  if (!Number.isFinite(num) || Math.abs(num) > Number.MAX_SAFE_INTEGER) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  if (effectiveConstraints.integer && !Number.isSafeInteger(num)) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  if (effectiveConstraints.nonNegative && num < 0) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must be ${description}.`);
  }
  if (effectiveConstraints.positive && num <= 0) {
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
  const resolved = value === undefined ? fallback : context.resolve(String(value));
  return resolveNumeric(resolved, name)!;
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

export function assertMaestroScriptsTrusted(options: MaestroEngineOptions, field: string): void {
  if (options.trustedScripts !== false) return;
  throw new AppError(
    'UNAUTHORIZED',
    `Maestro ${field} is not permitted for flows received over the remote daemon surface: ` +
      'node:vm is not a security sandbox, so an untrusted expression can escape to the host.',
  );
}

// Literals, maestro.platform comparisons, and ${VAR} lookups run without JavaScript, so remote flows keep them.
export async function conditionTruthMatches(
  truth: boolean | string | undefined,
  field: string,
  context: MaestroExecutionContext,
  options: MaestroEngineOptions,
): Promise<boolean> {
  if (truth === undefined) return true;
  if (typeof truth === 'boolean') return truth;
  const resolved = resolveWithoutScript(truth, context);
  if (resolved !== undefined) {
    const restricted = tryEvaluateMaestroBooleanExpression(resolved, options.platform);
    if (restricted !== undefined) return restricted;
    if (!resolved.includes('${')) return isMaestroConditionTruthy(resolved);
  }
  assertMaestroScriptsTrusted(options, field);
  // ponytail: function-scoped import keeps engine-eval-script (and node:vm) out of the maestro eager closure.
  const { evaluateMaestroConditionScript } = await import('./engine-eval-script.ts');
  const result = await evaluateMaestroConditionScript(
    truth,
    context.values,
    options.platform,
    field,
  );
  context.replaceOutput(result.outputEnv);
  return isMaestroScriptResultTruthy(result.value);
}

function resolveWithoutScript(value: string, context: MaestroExecutionContext): string | undefined {
  try {
    return context.resolve(value);
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_ARGS') return undefined;
    throw error;
  }
}

export function observationConditions(
  condition: MaestroRunFlowCondition,
  context: MaestroExecutionContext,
): MaestroObservationCondition[] {
  return [
    ...(condition.visible
      ? [{ kind: 'visible' as const, selector: resolveValue(condition.visible, context) }]
      : []),
    ...(condition.notVisible
      ? [{ kind: 'notVisible' as const, selector: resolveValue(condition.notVisible, context) }]
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
