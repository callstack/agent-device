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

/**
 * One dispatch expression, identified by source position. Attribution subtracts
 * occurrences: two dispatches of the same command are two sites, so a stray one
 * cannot be absorbed by a routed one that happens to name the same command.
 */
type DispatchSite = Readonly<{ command: string; offset: number }>;

type RouteScan = Readonly<{
  dispatches: readonly RouteDispatch[];
  /** Commands dispatched at a site no `command === '<name>'` route could claim. */
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
function dispatchSiteOf(node: AstNode): DispatchSite | undefined {
  if (node.type !== 'Property' || node['computed'] === true) return undefined;
  if (identifierName(node['key']) !== 'command') return undefined;
  const command = dispatchTargetOf(node['value']);
  if (command === undefined) return undefined;
  // A node without a source position cannot be matched against an attributed
  // site, so -1 keeps it distinct from every real offset and it stays unclaimed.
  const start = node['start'];
  return { command, offset: typeof start === 'number' ? start : -1 };
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

/** Dispatch sites reachable from `scope`, following calls to same-module functions. */
function reachableDispatches(
  scope: unknown,
  functions: ReadonlyMap<string, AstNode>,
  visited: Set<string>,
): DispatchSite[] {
  const found: DispatchSite[] = [];
  const calls: string[] = [];
  walk(scope, (node) => {
    const site = dispatchSiteOf(node);
    if (site !== undefined) found.push(site);
    if (node.type !== 'CallExpression') return;
    const callee = identifierName(node['callee']);
    if (callee !== undefined && functions.has(callee)) calls.push(callee);
  });
  for (const name of calls) {
    if (visited.has(name)) continue;
    visited.add(name);
    found.push(...reachableDispatches(functions.get(name), functions, visited));
  }
  return found;
}

function scanCliRouteDispatches(sourceText: string): RouteScan {
  const program = parseSync('cli.ts', sourceText).program;
  const functions = localFunctionsByName(program);
  const edges = new Set<string>();
  const dispatches: RouteDispatch[] = [];
  const attributedOffsets = new Set<number>();

  walk(program, (node) => {
    if (node.type !== 'IfStatement') return;
    const route = routedCommandOf(node['test']);
    if (route === undefined) return;
    for (const site of reachableDispatches(node['consequent'], functions, new Set())) {
      attributedOffsets.add(site.offset);
      const edge = `${route} ${site.command}`;
      if (edges.has(edge)) continue;
      edges.add(edge);
      dispatches.push({ route, dispatched: site.command });
    }
  });

  const allSites: DispatchSite[] = [];
  walk(program, (node) => {
    const site = dispatchSiteOf(node);
    if (site !== undefined) allSites.push(site);
  });

  const unclaimed = allSites
    .filter(({ offset }) => !attributedOffsets.has(offset))
    .map(({ command }) => command);

  return { dispatches, unattributed: [...new Set(unclaimed)].sort() };
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

  test('planted red: a stray dispatch sharing a routed target name is still reported', () => {
    const planted = `
      async function runCli(argv, deps) {
        if (command === 'react-devtools') {
          await runReactDevtoolsCli(ctx, deps);
          return;
        }
        await deps.sendToDaemon({ command: INTERNAL_COMMANDS.runtime, positionals: ['stray'] });
      }
      async function runReactDevtoolsCli(ctx, deps) {
        await deps.sendToDaemon({ command: INTERNAL_COMMANDS.runtime, positionals: [] });
      }
    `;
    const scan = scanCliRouteDispatches(planted);

    // Both halves matter: the routed occurrence is claimed, the stray one is not.
    expect(scan.dispatches).toEqual([{ route: 'react-devtools', dispatched: 'runtime' }]);
    expect(scan.unattributed).toEqual(['runtime']);
  });
});
