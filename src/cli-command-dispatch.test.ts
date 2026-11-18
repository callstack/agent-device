import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { isKnownCliCommandName } from '@agent-device/command-registry/catalog';

test('cli.ts command dispatch checks are recognized by parser-level unknown-command handling', () => {
  const commands = collectCliDispatchCommandLiterals();
  // The exact set, so a reader that collects nothing, or stops collecting, fails here instead
  // of passing over an empty loop.
  assert.deepEqual([...commands].sort(), [
    'auth',
    'batch',
    'cdp',
    'close',
    'connect',
    'connection',
    'daemon',
    'device',
    'disconnect',
    'help',
    'mcp',
    'open',
    'plugins',
    'proxy',
    'react-devtools',
    'runtime',
    'test',
    'web',
  ]);
  for (const command of commands) {
    assert.equal(
      isKnownCliCommandName(command),
      true,
      `cli.ts checks command "${command}" but the parser does not recognize it`,
    );
  }
});

function collectCliDispatchCommandLiterals(): Set<string> {
  const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const sourceText = fs.readFileSync(cliPath, 'utf8');
  const parsed = parseSync(cliPath, sourceText);
  const commands = new Set<string>();

  visitAstNodes(parsed.program, (node) => {
    const command = readBinaryComparisonCommandLiteral(node);
    if (command) commands.add(command);
  });

  return commands;
}

/**
 * The node fields this reader walks, declared locally instead of taken from `oxc-parser`. The
 * range gate classifies every parameter type it meets, and `oxc-parser`'s `Expression` union is
 * every AST kind, each a record of further such unions. No function here takes that union.
 */
type AstNode = {
  type: string;
  name?: string;
  operator?: string;
  computed?: boolean;
  value?: unknown;
  left?: AstNode;
  right?: AstNode;
  expression?: AstNode;
  expressions?: AstNode[];
  property?: AstNode;
  quasis?: { value: { cooked?: string } }[];
};

function isAstNode(value: unknown): value is AstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function visitAstNodes(root: AstNode, visit: (node: AstNode) => void): void {
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    visit(node);
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isAstNode(child)) stack.push(child);
      }
    }
  }
}

function readBinaryComparisonCommandLiteral(node: AstNode): string | null {
  if (node.type !== 'BinaryExpression') return null;
  if (node.operator !== '===' && node.operator !== '!==') return null;
  if (node.left == null || node.right == null) return null;
  return (
    readCommandComparisonLiteral(node.left, node.right) ??
    readCommandComparisonLiteral(node.right, node.left)
  );
}

function readCommandComparisonLiteral(commandSide: AstNode, literalSide: AstNode): string | null {
  if (!isCommandExpression(commandSide)) return null;
  return readStringLiteralText(unwrapParenthesizedExpression(literalSide));
}

function isCommandExpression(expression: AstNode): boolean {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (unwrapped.type === 'Identifier') return unwrapped.name === 'command';
  return (
    unwrapped.type === 'MemberExpression' &&
    !unwrapped.computed &&
    unwrapped.property?.type === 'Identifier' &&
    unwrapped.property.name === 'command'
  );
}

// Mirrors ts.isStringLiteralLike: string literals plus substitution-free templates.
function readStringLiteralText(expression: AstNode): string | null {
  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }
  if (expression.type === 'TemplateLiteral' && expression.expressions?.length === 0) {
    const cooked = expression.quasis?.[0]?.value.cooked;
    return typeof cooked === 'string' ? cooked : null;
  }
  return null;
}

function unwrapParenthesizedExpression(expression: AstNode): AstNode {
  let current = expression;
  while (current.type === 'ParenthesizedExpression' && current.expression != null) {
    current = current.expression;
  }
  return current;
}
