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
  return (
    readPlatformToken(remaining) ??
    readOperatorToken(remaining) ??
    readParenToken(remaining) ??
    readQuotedToken(remaining) ??
    readBooleanToken(remaining)
  );
}

type ReadToken = { value: MaestroBooleanToken; length: number };

function readPlatformToken(remaining: string): ReadToken | null {
  const platform = 'maestro.platform';
  return remaining.startsWith(platform)
    ? { value: { type: 'platform' }, length: platform.length }
    : null;
}

function readOperatorToken(remaining: string): ReadToken | null {
  const operator = /^(==|!=|&&|\|\|)/.exec(remaining)?.[1];
  if (!operator) return null;
  return {
    value: {
      type: 'operator',
      value: operator as Extract<MaestroBooleanToken, { type: 'operator' }>['value'],
    },
    length: operator.length,
  };
}

function readParenToken(remaining: string): ReadToken | null {
  const paren = remaining[0];
  return paren === '(' || paren === ')'
    ? { value: { type: 'paren', value: paren }, length: 1 }
    : null;
}

function readQuotedToken(remaining: string): ReadToken | null {
  const quoted = /^(['"])(.*?)\1/.exec(remaining);
  return quoted
    ? { value: { type: 'string', value: quoted[2] ?? '' }, length: quoted[0].length }
    : null;
}

function readBooleanToken(remaining: string): ReadToken | null {
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
    this.consumePlatformToken();
    const operator = this.consumeComparisonOperator();
    const expectedPlatform = this.consumeStringLiteral();
    const matches = this.platform === expectedPlatform.toLowerCase();
    return operator.value === '==' ? matches : !matches;
  }

  private consumePlatformToken(): void {
    if (this.peek()?.type !== 'platform') {
      throw new AppError(
        'INVALID_ARGS',
        'runFlow.when.true supports maestro.platform comparisons.',
      );
    }
    this.index += 1;
  }

  private consumeComparisonOperator(): Extract<MaestroBooleanToken, { type: 'operator' }> {
    const token = this.peek();
    if (token?.type !== 'operator' || (token.value !== '==' && token.value !== '!=')) {
      throw new AppError('INVALID_ARGS', 'runFlow.when.true comparison requires == or !=.');
    }
    this.index += 1;
    return token;
  }

  private consumeStringLiteral(): string {
    const token = this.peek();
    if (token?.type !== 'string') {
      throw new AppError('INVALID_ARGS', 'runFlow.when.true comparison requires a string literal.');
    }
    this.index += 1;
    return token.value;
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
