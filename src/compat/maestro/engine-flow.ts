import { AppError } from '../../kernel/errors.ts';
import type {
  MaestroCommand,
  MaestroProgram,
  MaestroRunFlowCommand,
  MaestroRunFlowCondition,
} from './program-ir.ts';
import { MaestroExecutionContext } from './engine-context.ts';
import type { MaestroEngineOptions, MaestroObservationCondition } from './engine-types.ts';

export function resolveCommand<T extends MaestroCommand>(
  command: T,
  context: MaestroExecutionContext,
): T {
  return {
    ...resolveValue(command, context),
    source: command.source,
  };
}

export function readIterationCount(
  value: number | string | undefined,
  fallback: number,
  context: MaestroExecutionContext,
  name: string,
): number {
  const resolved = value === undefined ? fallback : Number(context.resolve(String(value)));
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new AppError('INVALID_ARGS', `Maestro ${name} must resolve to a non-negative integer.`);
  }
  return resolved;
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
  return await options.loadProgram(command.include.path, command.source.path);
}

export function staticConditionMatches(
  condition: MaestroRunFlowCondition,
  context: MaestroExecutionContext,
  options: MaestroEngineOptions,
): boolean {
  if (condition.platform && condition.platform !== options.platform) return false;
  if (condition.true === undefined) return true;
  if (typeof condition.true === 'boolean') return condition.true;
  const expression = context.resolve(condition.true).trim();
  if (expression === 'true') return true;
  if (expression === 'false') return false;
  if (options.evaluateExpression) return options.evaluateExpression(expression, context.values);
  throw new AppError('INVALID_ARGS', 'Maestro runFlow.when.true expression requires an evaluator.');
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
