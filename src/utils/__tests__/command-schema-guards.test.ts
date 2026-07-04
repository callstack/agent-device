import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import type { BinaryExpression, Expression, PrivateIdentifier } from 'oxc-parser';
import { listCapabilityCommands } from '../../core/capabilities.ts';
import {
  INTERNAL_COMMANDS,
  isKnownCliCommandName,
  listCapabilityCheckedCommandNames,
  listCliCommandNames,
  SPECIAL_CLI_COMMANDS,
} from '../../command-catalog.ts';
import { getCliCommandSchema } from '../command-schema.ts';

test('every public capability command has a parser schema entry', () => {
  const schemaCommands = new Set<string>(listCliCommandNames());
  for (const command of listCapabilityCommands()) {
    if (INTERNAL_GESTURE_CAPABILITY_COMMANDS.has(command)) continue;
    assert.equal(schemaCommands.has(command), true, `Missing schema for command: ${command}`);
  }
});

test('every CLI command has a derived or local parser schema entry', () => {
  for (const command of listCliCommandNames()) {
    assert.doesNotThrow(
      () => getCliCommandSchema(command),
      `Missing schema for command: ${command}`,
    );
  }
});

test('known CLI command predicate covers catalog, help, and internal commands', () => {
  for (const command of listCliCommandNames()) {
    assert.equal(isKnownCliCommandName(command), true, `Missing CLI command: ${command}`);
  }
  for (const command of Object.values(SPECIAL_CLI_COMMANDS)) {
    assert.equal(isKnownCliCommandName(command), true, `Missing special command: ${command}`);
  }
  for (const command of Object.values(INTERNAL_COMMANDS)) {
    assert.equal(isKnownCliCommandName(command), true, `Missing internal command: ${command}`);
  }
  assert.equal(isKnownCliCommandName('tap'), false);
  assert.equal(isKnownCliCommandName('not-a-command'), false);
});

test('cli.ts command dispatch checks are recognized by parser-level unknown-command handling', () => {
  const commands = collectCliDispatchCommandLiterals();
  assert.notEqual(commands.size, 0);
  for (const command of commands) {
    assert.equal(
      isKnownCliCommandName(command),
      true,
      `cli.ts checks command "${command}" but the parser does not recognize it`,
    );
  }
});

test('schema capability mappings match capability source-of-truth', () => {
  assert.deepEqual(
    listCapabilityCheckedCommandNames(),
    listCapabilityCommands().filter(
      (command) => !INTERNAL_GESTURE_CAPABILITY_COMMANDS.has(command),
    ),
  );
});

const INTERNAL_GESTURE_CAPABILITY_COMMANDS = new Set([
  'pan',
  'fling',
  'pinch',
  'rotate-gesture',
  'transform-gesture',
]);

function collectCliDispatchCommandLiterals(): Set<string> {
  const cliPath = fileURLToPath(new URL('../../cli.ts', import.meta.url));
  const sourceText = fs.readFileSync(cliPath, 'utf8');
  const parsed = parseSync(cliPath, sourceText);
  const commands = new Set<string>();

  visitAstNodes(parsed.program, (node) => {
    const command = readBinaryComparisonCommandLiteral(node);
    if (command) commands.add(command);
  });

  return commands;
}

type AstNode = { type: string };

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
  const binary = node as unknown as BinaryExpression;
  if (binary.operator !== '===' && binary.operator !== '!==') return null;
  return (
    readCommandComparisonLiteral(binary.left, binary.right) ??
    readCommandComparisonLiteral(binary.right, binary.left)
  );
}

function readCommandComparisonLiteral(
  commandSide: Expression | PrivateIdentifier,
  literalSide: Expression | PrivateIdentifier,
): string | null {
  if (!isCommandExpression(commandSide)) return null;
  return readStringLiteralText(unwrapParenthesizedExpression(literalSide));
}

function isCommandExpression(expression: Expression | PrivateIdentifier): boolean {
  const unwrapped = unwrapParenthesizedExpression(expression);
  if (unwrapped.type === 'Identifier') return unwrapped.name === 'command';
  return (
    unwrapped.type === 'MemberExpression' &&
    !unwrapped.computed &&
    unwrapped.property.type === 'Identifier' &&
    unwrapped.property.name === 'command'
  );
}

// Mirrors ts.isStringLiteralLike: string literals plus substitution-free templates.
function readStringLiteralText(expression: Expression | PrivateIdentifier): string | null {
  if (expression.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }
  if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

function unwrapParenthesizedExpression(
  expression: Expression | PrivateIdentifier,
): Expression | PrivateIdentifier {
  let current = expression;
  while (current.type === 'ParenthesizedExpression') {
    current = current.expression;
  }
  return current;
}
