import type { SessionAction } from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import { maestroSelector } from './interactions.ts';
import {
  action,
  assertOnlyKeys,
  isPlainRecord,
  normalizeCommandList,
  readEnvMap,
  resolveMaestroString,
  unsupportedMaestroSyntax,
} from './support.ts';
import type {
  MaestroCommand,
  MaestroCommandMapperDeps,
  MaestroFlowConfig,
  MaestroParseContext,
} from './types.ts';

// repeat.times is expanded at parse time for deterministic replay traces. Keep
// a guardrail until repeat can execute as a runtime loop without materializing
// every child action.
const MAX_REPEAT_EXPANSIONS = 1000;
type MaestroConditionPlatform = 'android' | 'ios' | 'web';

type ConvertCommandList = (
  commands: MaestroCommand[],
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
) => SessionAction[];

export function convertRunFlow(
  value: unknown,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
  convertCommandList: ConvertCommandList,
): SessionAction[] {
  if (typeof value === 'string') {
    return deps.parseRunFlowFile(resolveMaestroString(value, context), context).actions;
  }
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'runFlow expects a file path string or map.');
  }
  assertOnlyKeys(value, 'runFlow', ['file', 'commands', 'env', 'when', 'label']);
  const condition = readRunFlowCondition(value.when, context);
  if (!condition.shouldRun) return [];

  const runContext = {
    ...context,
    env: { ...context.env, ...readEnvMap(value.env, 'runFlow.env'), ...context.envOverrides },
  };
  const actions = readRunFlowActions(value, config, runContext, deps, convertCommandList);
  return wrapRunFlowCondition(actions, condition);
}

export function convertRepeat(
  value: unknown,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
  convertCommandList: ConvertCommandList,
): SessionAction[] {
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'repeat expects a map.');
  }
  assertOnlyKeys(value, 'repeat', ['times', 'commands', 'while']);
  if (value.while !== undefined) {
    throw unsupportedMaestroSyntax(
      'Maestro repeat.while is not supported yet. Only deterministic repeat.times is supported.',
    );
  }
  const times = readRepeatTimes(value.times, context);
  if (!Array.isArray(value.commands)) {
    throw new AppError('INVALID_ARGS', 'repeat requires a commands list.');
  }
  if (times > MAX_REPEAT_EXPANSIONS) {
    throw new AppError(
      'INVALID_ARGS',
      `repeat.times must be <= ${MAX_REPEAT_EXPANSIONS} for deterministic replay expansion.`,
    );
  }
  const commands = normalizeCommandList(value.commands);
  return Array.from({ length: times }).flatMap(() =>
    convertCommandList(commands, config, context, deps),
  );
}

export function convertRetry(
  value: unknown,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
  convertCommandList: ConvertCommandList,
): SessionAction[] {
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'retry expects a map.');
  }
  assertOnlyKeys(value, 'retry', ['maxRetries', 'commands']);
  if (!Array.isArray(value.commands)) {
    throw new AppError('INVALID_ARGS', 'retry requires a commands list.');
  }
  const maxRetries = readRetryMaxRetries(value.maxRetries, context);
  const commands = normalizeCommandList(value.commands);
  const actions = convertCommandList(commands, config, context, deps);
  return [
    replayControlAction('retry', [String(maxRetries)], {
      kind: 'retry',
      maxRetries,
      actions,
    }),
  ];
}

function readRunFlowActions(
  value: Record<string, unknown>,
  config: MaestroFlowConfig,
  context: MaestroParseContext,
  deps: MaestroCommandMapperDeps,
  convertCommandList: ConvertCommandList,
): SessionAction[] {
  if (typeof value.file === 'string') {
    return deps.parseRunFlowFile(resolveMaestroString(value.file, context), context).actions;
  }
  if (Array.isArray(value.commands)) {
    return convertCommandList(normalizeCommandList(value.commands), config, context, deps);
  }
  throw new AppError('INVALID_ARGS', 'runFlow map requires either file or commands.');
}

type RunFlowCondition = {
  shouldRun: boolean;
  visibleSelector?: string;
  notVisibleSelector?: string;
};

function readRunFlowCondition(value: unknown, context: MaestroParseContext): RunFlowCondition {
  if (value === undefined || value === null) return { shouldRun: true };
  if (!isPlainRecord(value)) {
    throw new AppError('INVALID_ARGS', 'runFlow.when expects a map.');
  }
  assertOnlyKeys(value, 'runFlow.when', ['platform', 'visible', 'notVisible', 'true']);
  if (!matchesRunFlowStaticCondition(value, context)) return { shouldRun: false };
  return {
    shouldRun: true,
    ...readRunFlowVisibilityCondition(value, context),
  };
}

function matchesRunFlowStaticCondition(
  value: Record<string, unknown>,
  context: MaestroParseContext,
): boolean {
  if (value.true !== undefined && !evaluateRunFlowTrueCondition(value.true, context)) return false;
  if (value.platform === undefined) return true;
  const platform = normalizeRunFlowPlatform(value.platform, 'runFlow.when.platform');
  if (!context.platform) {
    throw new AppError(
      'INVALID_ARGS',
      'Maestro runFlow.when.platform requires replay to be run with --platform ios|android.',
    );
  }
  return platform === context.platform;
}

function readRunFlowVisibilityCondition(
  value: Record<string, unknown>,
  context: MaestroParseContext,
): Pick<RunFlowCondition, 'visibleSelector' | 'notVisibleSelector'> {
  return {
    ...(value.visible !== undefined
      ? { visibleSelector: maestroSelector(value.visible, 'runFlow.when.visible', [], context) }
      : {}),
    ...(value.notVisible !== undefined
      ? {
          notVisibleSelector: maestroSelector(
            value.notVisible,
            'runFlow.when.notVisible',
            [],
            context,
          ),
        }
      : {}),
  };
}

function normalizeRunFlowPlatform(value: unknown, name: string): MaestroConditionPlatform {
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', `${name} expects Android, iOS, or Web.`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'android' || normalized === 'ios' || normalized === 'web') {
    return normalized;
  }
  throw new AppError('INVALID_ARGS', `${name} expects Android, iOS, or Web.`);
}

function evaluateRunFlowTrueCondition(value: unknown, context: MaestroParseContext): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') {
    throw new AppError('INVALID_ARGS', 'runFlow.when.true expects a boolean or expression string.');
  }
  const expression = unwrapMaestroExpression(resolveMaestroString(value, context));
  const parser = new MaestroBooleanExpressionParser(tokenizeMaestroBooleanExpression(expression), {
    platform: context.platform,
  });
  return parser.parse();
}

function unwrapMaestroExpression(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('${') && trimmed.endsWith('}') ? trimmed.slice(2, -1).trim() : trimmed;
}

type MaestroBooleanToken =
  | { type: 'platform' }
  | MaestroBooleanOperatorToken
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean };

type MaestroBooleanOperatorToken = { type: 'operator'; value: '==' | '!=' | '&&' | '||' };

type MaestroBooleanTokenMatch = {
  token: MaestroBooleanToken;
  length: number;
};

function tokenizeMaestroBooleanExpression(expression: string): MaestroBooleanToken[] {
  const tokens: MaestroBooleanToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const remaining = expression.slice(index);
    const skipped = whitespaceLength(remaining);
    if (skipped > 0) {
      index += skipped;
      continue;
    }
    const next = readMaestroBooleanToken(remaining);
    if (next) {
      tokens.push(next.token);
      index += next.length;
      continue;
    }
    throw new AppError(
      'INVALID_ARGS',
      `Unsupported runFlow.when.true expression near "${remaining.slice(0, 24)}".`,
    );
  }
  return tokens;
}

function whitespaceLength(value: string): number {
  return /^\s+/.exec(value)?.[0].length ?? 0;
}

function readMaestroBooleanToken(remaining: string): MaestroBooleanTokenMatch | null {
  return (
    readPlatformToken(remaining) ??
    readOperatorToken(remaining) ??
    readParenToken(remaining) ??
    readStringToken(remaining) ??
    readBooleanToken(remaining)
  );
}

function readPlatformToken(remaining: string): MaestroBooleanTokenMatch | null {
  const name = 'maestro.platform';
  return remaining.startsWith(name) ? { token: { type: 'platform' }, length: name.length } : null;
}

function readOperatorToken(remaining: string): MaestroBooleanTokenMatch | null {
  const operator = /^(==|!=|&&|\|\|)/.exec(remaining)?.[1];
  return operator
    ? {
        token: { type: 'operator', value: operator as MaestroBooleanOperatorToken['value'] },
        length: operator.length,
      }
    : null;
}

function readParenToken(remaining: string): MaestroBooleanTokenMatch | null {
  const value = remaining[0];
  return value === '(' || value === ')' ? { token: { type: 'paren', value }, length: 1 } : null;
}

function readStringToken(remaining: string): MaestroBooleanTokenMatch | null {
  const quoted = /^(['"])(.*?)\1/.exec(remaining);
  return quoted
    ? { token: { type: 'string', value: quoted[2] ?? '' }, length: quoted[0].length }
    : null;
}

function readBooleanToken(remaining: string): MaestroBooleanTokenMatch | null {
  const value = /^(true|false)\b/.exec(remaining)?.[1];
  return value
    ? { token: { type: 'boolean', value: value === 'true' }, length: value.length }
    : null;
}

class MaestroBooleanExpressionParser {
  private index = 0;
  private readonly tokens: MaestroBooleanToken[];
  private readonly context: { platform?: 'android' | 'ios' };

  constructor(tokens: MaestroBooleanToken[], context: { platform?: 'android' | 'ios' }) {
    this.tokens = tokens;
    this.context = context;
  }

  parse(): boolean {
    const result = this.parseOr();
    if (this.peek()) {
      throw new AppError('INVALID_ARGS', 'Unsupported trailing runFlow.when.true expression.');
    }
    return result;
  }

  private parseOr(): boolean {
    let result = this.parseAnd();
    while (this.consumeOperator('||')) {
      result = this.parseAnd() || result;
    }
    return result;
  }

  private parseAnd(): boolean {
    let result = this.parsePrimary();
    while (this.consumeOperator('&&')) {
      result = this.parsePrimary() && result;
    }
    return result;
  }

  private parsePrimary(): boolean {
    const token = this.peek();
    if (!token) {
      throw new AppError('INVALID_ARGS', 'Incomplete runFlow.when.true expression.');
    }
    if (token.type === 'boolean') {
      this.index += 1;
      return token.value;
    }
    if (token.type === 'paren' && token.value === '(') {
      this.index += 1;
      const result = this.parseOr();
      if (!this.consumeParen(')')) {
        throw new AppError('INVALID_ARGS', 'Unclosed runFlow.when.true parenthesis.');
      }
      return result;
    }
    return this.parsePlatformComparison();
  }

  private parsePlatformComparison(): boolean {
    this.expectPlatform();
    const operator = this.expectEqualityOperator();
    const value = this.expectString().toLowerCase();
    const platform = this.context.platform;
    return operator === '==' ? platform === value : platform !== value;
  }

  private expectPlatform(): void {
    if (this.peek()?.type !== 'platform') {
      throw new AppError(
        'INVALID_ARGS',
        'runFlow.when.true supports maestro.platform comparisons.',
      );
    }
    this.index += 1;
  }

  private expectEqualityOperator(): '==' | '!=' {
    const token = this.peek();
    if (token?.type === 'operator' && (token.value === '==' || token.value === '!=')) {
      this.index += 1;
      return token.value;
    }
    throw new AppError('INVALID_ARGS', 'runFlow.when.true comparison requires == or !=.');
  }

  private expectString(): string {
    const token = this.peek();
    if (token?.type === 'string') {
      this.index += 1;
      return token.value;
    }
    throw new AppError('INVALID_ARGS', 'runFlow.when.true comparison requires a string literal.');
  }

  private consumeOperator(value: '&&' | '||'): boolean {
    const token = this.peek();
    if (token?.type !== 'operator' || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private consumeParen(value: '(' | ')'): boolean {
    const token = this.peek();
    if (token?.type !== 'paren' || token.value !== value) return false;
    this.index += 1;
    return true;
  }

  private peek(): MaestroBooleanToken | undefined {
    return this.tokens[this.index];
  }
}

function wrapRunFlowCondition(
  actions: SessionAction[],
  condition: RunFlowCondition,
): SessionAction[] {
  const { visibleSelector, notVisibleSelector } = condition;
  if (!visibleSelector && !notVisibleSelector) return actions;
  if (visibleSelector && notVisibleSelector) {
    throw unsupportedMaestroSyntax(
      'Maestro runFlow.when cannot combine visible and notVisible yet.',
    );
  }
  const mode = visibleSelector ? 'visible' : 'notVisible';
  const selector = visibleSelector ?? notVisibleSelector ?? '';
  return [
    replayControlAction('runFlow.when', [mode, selector], {
      kind: 'maestroRunFlowWhen',
      mode,
      selector,
      actions,
    }),
  ];
}

function replayControlAction(
  command: string,
  positionals: string[],
  replayControl: NonNullable<SessionAction['replayControl']>,
): SessionAction {
  return {
    ...action(command, positionals),
    replayControl,
  };
}

function readRepeatTimes(value: unknown, context: MaestroParseContext): number {
  return readMaestroNonNegativeInteger(value, context, 'repeat.times');
}

function readRetryMaxRetries(value: unknown, context: MaestroParseContext): number {
  if (value === undefined) return 1;
  return readMaestroNonNegativeInteger(value, context, 'retry.maxRetries');
}

function readMaestroNonNegativeInteger(
  value: unknown,
  context: MaestroParseContext,
  name: string,
): number {
  const resolved = typeof value === 'string' ? resolveMaestroString(value, context) : value;
  const numeric =
    typeof resolved === 'number'
      ? resolved
      : typeof resolved === 'string' && /^\d+$/.test(resolved)
        ? Number(resolved)
        : undefined;
  if (numeric === undefined || !Number.isInteger(numeric) || numeric < 0) {
    throw new AppError(
      'INVALID_ARGS',
      `${name} must be a non-negative integer or \${VAR} resolving to one.`,
    );
  }
  return numeric;
}
