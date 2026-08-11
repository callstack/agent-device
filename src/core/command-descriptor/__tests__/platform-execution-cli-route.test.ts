import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { describe, expect, test } from 'vitest';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { commandDescriptors } from '../registry.ts';

/**
 * ADR 0019 §6 coherence gate for delegated platform execution.
 *
 * The registry entry gate inspects one descriptor at a time, so it cannot see a
 * command whose own module holds no platform code while its CLI route injects a
 * callback that dispatches a platform-executing command. Mode dominance closes
 * that: if the CLI route for command R dispatches command D, R may declare `none`
 * only when D is `none` too.
 *
 * Scope is `src/cli.ts`, the composition root where injected callbacks are built.
 * The scan is total within it — a dispatch no route can claim fails the gate.
 */

type AstNode = { type: string } & Record<string, unknown>;

const CLI_COMPOSITION_ROOT = fileURLToPath(new URL('../../../cli.ts', import.meta.url));

const COMMAND_CATALOGS: Record<string, Record<string, string>> = {
  INTERNAL_COMMANDS,
  PUBLIC_COMMANDS,
};

const COMMAND_NAMES = new Set<string>(commandDescriptors.map(({ name }) => name));

type PlatformExecutionKindOf = (command: string) => string | undefined;

const registryKind: PlatformExecutionKindOf = (command) =>
  commandDescriptors.find(({ name }) => name === command)?.platformExecution.kind;

type RouteDispatch = Readonly<{ route: string; dispatched: string }>;

type RouteScan = Readonly<{
  dispatches: readonly RouteDispatch[];
  /** Dispatch literals no `command === '<name>'` route could claim. */
  unattributed: readonly string[];
}>;

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function walk(root: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(root)) {
    for (const child of root) walk(child, visit);
    return;
  }
  if (!isAstNode(root)) return;
  visit(root);
  for (const value of Object.values(root)) walk(value, visit);
}

function identifierName(node: unknown): string | undefined {
  return isAstNode(node) && node.type === 'Identifier' ? String(node['name']) : undefined;
}

function stringLiteral(node: unknown): string | undefined {
  return isAstNode(node) && node.type === 'Literal' && typeof node['value'] === 'string'
    ? node['value']
    : undefined;
}

function knownCommand(name: string | undefined): string | undefined {
  return name !== undefined && COMMAND_NAMES.has(name) ? name : undefined;
}

/** `command === 'react-devtools'`, either operand order, names a routed command. */
function routedCommandOf(test: unknown): string | undefined {
  if (!isAstNode(test) || test.type !== 'BinaryExpression' || test['operator'] !== '===') {
    return undefined;
  }
  const operands = [
    [test['left'], test['right']],
    [test['right'], test['left']],
  ] as const;
  for (const [subject, literal] of operands) {
    if (identifierName(subject) !== 'command') continue;
    const routed = knownCommand(stringLiteral(literal));
    if (routed !== undefined) return routed;
  }
  return undefined;
}

/** `command: 'x'`, `command: INTERNAL_COMMANDS.x`, `command: PUBLIC_COMMANDS.x`. */
function dispatchedCommandOf(node: AstNode): string | undefined {
  if (node.type !== 'Property' || node['computed'] === true) return undefined;
  if (identifierName(node['key']) !== 'command') return undefined;
  return dispatchTargetOf(node['value']);
}

function dispatchTargetOf(value: unknown): string | undefined {
  const literal = stringLiteral(value);
  if (literal !== undefined) return knownCommand(literal);
  if (!isAstNode(value) || value.type !== 'MemberExpression' || value['computed'] === true) {
    return undefined;
  }
  const catalog = identifierName(value['object']);
  const key = identifierName(value['property']);
  return catalog === undefined || key === undefined ? undefined : COMMAND_CATALOGS[catalog]?.[key];
}

function localFunctionsByName(program: unknown): Map<string, AstNode> {
  const functions = new Map<string, AstNode>();
  walk(program, (node) => {
    if (node.type !== 'FunctionDeclaration') return;
    const name = identifierName(node['id']);
    if (name !== undefined) functions.set(name, node);
  });
  return functions;
}

/** Dispatch literals reachable from `scope`, following calls to same-module functions. */
function reachableDispatches(
  scope: unknown,
  functions: ReadonlyMap<string, AstNode>,
  visited: Set<string>,
): Set<string> {
  const found = new Set<string>();
  const calls: string[] = [];
  walk(scope, (node) => {
    const dispatched = dispatchedCommandOf(node);
    if (dispatched !== undefined) found.add(dispatched);
    if (node.type !== 'CallExpression') return;
    const callee = identifierName(node['callee']);
    if (callee !== undefined && functions.has(callee)) calls.push(callee);
  });
  for (const name of calls) {
    if (visited.has(name)) continue;
    visited.add(name);
    for (const dispatched of reachableDispatches(functions.get(name), functions, visited)) {
      found.add(dispatched);
    }
  }
  return found;
}

function scanCliRouteDispatches(sourceText: string): RouteScan {
  const program = parseSync('cli.ts', sourceText).program;
  const functions = localFunctionsByName(program);
  const dispatches: RouteDispatch[] = [];
  const attributed = new Set<string>();

  walk(program, (node) => {
    if (node.type !== 'IfStatement') return;
    const route = routedCommandOf(node['test']);
    if (route === undefined) return;
    for (const dispatched of reachableDispatches(node['consequent'], functions, new Set())) {
      dispatches.push({ route, dispatched });
      attributed.add(dispatched);
    }
  });

  const all = new Set<string>();
  walk(program, (node) => {
    const dispatched = dispatchedCommandOf(node);
    if (dispatched !== undefined) all.add(dispatched);
  });

  return {
    dispatches,
    unattributed: [...all].filter((command) => !attributed.has(command)).sort(),
  };
}

function dominanceFailures(scan: RouteScan, kindOf: PlatformExecutionKindOf): string[] {
  return scan.dispatches
    .filter(({ route, dispatched }) => kindOf(route) === 'none' && kindOf(dispatched) !== 'none')
    .map(
      ({ route, dispatched }) =>
        `${route} declares platformExecution none but its CLI route dispatches ${dispatched} (${String(kindOf(dispatched))})`,
    )
    .sort();
}

function scanCompositionRoot(): RouteScan {
  return scanCliRouteDispatches(fs.readFileSync(CLI_COMPOSITION_ROOT, 'utf8'));
}

describe('platform-execution coherence across CLI route delegation', () => {
  test('no none command dispatches a platform-executing command', () => {
    expect(dominanceFailures(scanCompositionRoot(), registryKind)).toEqual([]);
  });

  test('every CLI daemon dispatch is attributable to a routed command', () => {
    expect(scanCompositionRoot().unattributed).toEqual([]);
  });

  test('the composition root still carries the react-devtools runtime delegation', () => {
    expect(scanCompositionRoot().dispatches).toContainEqual({
      route: 'react-devtools',
      dispatched: 'runtime',
    });
  });

  test('planted red: react-devtools declared none is rejected by the real route', () => {
    const plantedNone: PlatformExecutionKindOf = (command) =>
      command === 'react-devtools' ? 'none' : registryKind(command);

    expect(dominanceFailures(scanCompositionRoot(), plantedNone)).toEqual([
      'react-devtools declares platformExecution none but its CLI route dispatches runtime (legacy)',
    ]);
  });

  test('planted red: an unroutable dispatch is reported rather than ignored', () => {
    const planted = `
      async function runCli(argv, deps) {
        await deps.sendToDaemon({ command: INTERNAL_COMMANDS.runtime, positionals: [] });
      }
    `;
    expect(scanCliRouteDispatches(planted).unattributed).toEqual(['runtime']);
  });
});
