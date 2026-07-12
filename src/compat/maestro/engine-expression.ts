import { AppError } from '../../kernel/errors.ts';
import type { MaestroExecutionContext } from './engine-context.ts';
import type { MaestroPlatform } from './program-ir.ts';

export function evaluateMaestroBooleanExpression(
  value: string,
  context: MaestroExecutionContext,
  platform: MaestroPlatform | undefined,
): boolean {
  const resolved = unwrapMaestroExpression(context.resolve(value));
  return new MaestroBooleanExpressionParser(
    tokenizeMaestroBooleanExpression(resolved),
    platform,
  ).parse();
}

function unwrapMaestroExpression(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('${') && trimmed.endsWith('}') ? trimmed.slice(2, -1).trim() : trimmed;
}

type MaestroBooleanToken =
  | { type: 'platform' }
  | { type: 'operator'; value: '==' | '!=' | '&&' | '||' }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'string'; value: string }
  | { type: 'boolean'; value: boolean };

function tokenizeMaestroBooleanExpression(expression: string): MaestroBooleanToken[] {
  const tokens: MaestroBooleanToken[] = [];
  let index = 0;
  while (index < expression.length) {
    const remaining = expression.slice(index);
    const whitespace = /^\s+/.exec(remaining)?.[0].length ?? 0;
    if (whitespace > 0) {
      index += whitespace;
      continue;
    }
    const token = readMaestroBooleanToken(remaining);
    if (!token) {
      throw new AppError(
        'INVALID_ARGS',
        `Unsupported runFlow.when.true expression near "${remaining.slice(0, 24)}".`,
      );
    }
    tokens.push(token.value);
    index += token.length;
  }
  return tokens;
}

function readMaestroBooleanToken(
  remaining: string,
): { value: MaestroBooleanToken; length: number } | null {
  const platform = 'maestro.platform';
  if (remaining.startsWith(platform))
    return { value: { type: 'platform' }, length: platform.length };

  const operator = /^(==|!=|&&|\|\|)/.exec(remaining)?.[1];
  if (operator) {
    return {
      value: {
        type: 'operator',
        value: operator as Extract<MaestroBooleanToken, { type: 'operator' }>['value'],
      },
      length: operator.length,
    };
  }

  const paren = remaining[0];
  if (paren === '(' || paren === ')') return { value: { type: 'paren', value: paren }, length: 1 };

  const quoted = /^(['"])(.*?)\1/.exec(remaining);
  if (quoted)
    return { value: { type: 'string', value: quoted[2] ?? '' }, length: quoted[0].length };

  const boolean = /^(true|false)\b/.exec(remaining)?.[1];
  return boolean
    ? { value: { type: 'boolean', value: boolean === 'true' }, length: boolean.length }
    : null;
}

class MaestroBooleanExpressionParser {
  private index = 0;
  private readonly tokens: MaestroBooleanToken[];
  private readonly platform: MaestroPlatform | undefined;

  constructor(tokens: MaestroBooleanToken[], platform: MaestroPlatform | undefined) {
    this.tokens = tokens;
    this.platform = platform;
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
    while (this.consumeOperator('||')) result = this.parseAnd() || result;
    return result;
  }

  private parseAnd(): boolean {
    let result = this.parsePrimary();
    while (this.consumeOperator('&&')) result = this.parsePrimary() && result;
    return result;
  }

  private parsePrimary(): boolean {
    const token = this.peek();
    if (!token) throw new AppError('INVALID_ARGS', 'Incomplete runFlow.when.true expression.');
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
    if (this.peek()?.type !== 'platform') {
      throw new AppError(
        'INVALID_ARGS',
        'runFlow.when.true supports maestro.platform comparisons.',
      );
    }
    this.index += 1;
    const operator = this.peek();
    if (operator?.type !== 'operator' || (operator.value !== '==' && operator.value !== '!=')) {
      throw new AppError('INVALID_ARGS', 'runFlow.when.true comparison requires == or !=.');
    }
    this.index += 1;
    const string = this.peek();
    if (string?.type !== 'string') {
      throw new AppError('INVALID_ARGS', 'runFlow.when.true comparison requires a string literal.');
    }
    this.index += 1;
    const matches = this.platform === string.value.toLowerCase();
    return operator.value === '==' ? matches : !matches;
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
