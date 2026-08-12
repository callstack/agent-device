import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { describe, expect, test } from 'vitest';
import {
  CLI_INJECTED_DAEMON_DISPATCHES,
  type CliInjectedRoute,
} from '../../../cli/injected-daemon-dispatch.ts';
import { commandDescriptors } from '../registry.ts';

/**
 * ADR 0019 §6 coherence gate for delegated platform execution.
 *
 * The registry entry gate inspects one descriptor at a time, so it cannot see a command
 * whose own module holds no platform code while its CLI route injects a *different*
 * command that does. Mode dominance closes that: if a CLI route dispatches command D,
 * the route's command may declare `none` only when D is `none` too.
 *
 * The dispatched pairs are read from the typed table at the construction seam rather
 * than recovered from syntax. The second test keeps that seam singular, which is what
 * makes the table total: the transport cannot be called anywhere else, so there is no
 * second way to dispatch.
 */

const CLI_ROOT = fileURLToPath(new URL('../../../cli.ts', import.meta.url));
const CLI_DIR = fileURLToPath(new URL('../../../cli/', import.meta.url));
const SEAM_MODULE = path.join(CLI_DIR, 'injected-daemon-dispatch.ts');
const TRANSPORT = 'sendToDaemon';

type AstNode = { type: string } & Record<string, unknown>;

type PlatformExecutionKindOf = (command: string) => string | undefined;

const registryKind: PlatformExecutionKindOf = (command) =>
  commandDescriptors.find(({ name }) => name === command)?.platformExecution.kind;

type DispatchTable = Readonly<Record<string, readonly string[]>>;

function declaredPairs(table: DispatchTable): { route: string; dispatched: string }[] {
  return Object.entries(table).flatMap(([route, commands]) =>
    commands.map((dispatched) => ({ route, dispatched })),
  );
}

function dominanceFailures(
  kindOf: PlatformExecutionKindOf,
  table: DispatchTable = CLI_INJECTED_DAEMON_DISPATCHES,
): string[] {
  return declaredPairs(table)
    .filter(({ route, dispatched }) => kindOf(route) === 'none' && kindOf(dispatched) !== 'none')
    .map(
      ({ route, dispatched }) =>
        `${route} declares platformExecution none but its CLI route dispatches ${dispatched} (${String(kindOf(dispatched))})`,
    )
    .sort();
}

/**
 * The table's types reject an unregistered target, but a cast would slip past them and
 * then read as "no dominance failure" because an unknown command has no mode at all.
 * An unresolvable end of a declared pair is a gate error, not an absence.
 */
function unresolvedPairs(
  kindOf: PlatformExecutionKindOf,
  table: DispatchTable = CLI_INJECTED_DAEMON_DISPATCHES,
): string[] {
  return declaredPairs(table)
    .flatMap(({ route, dispatched }) => [
      ...(kindOf(route) === undefined ? [`route ${route} is not a registered command`] : []),
      ...(kindOf(dispatched) === undefined
        ? [`${route} dispatches ${dispatched}, which is not a registered command`]
        : []),
    ])
    .sort();
}

// ---------------------------------------------------------------------------
// Seam singularity. The rule is positional, not value-resolving: the transport
// identifier may appear only in the positions listed below. Anything else — a call,
// an alias, a form not yet imagined — fails, so the check cannot quietly miss a
// dispatch shape it was not taught to recognize.
// ---------------------------------------------------------------------------

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function walkWithParent(
  node: unknown,
  parent: AstNode | null,
  ancestors: readonly AstNode[],
  visit: (node: AstNode, parent: AstNode | null, ancestors: readonly AstNode[]) => void,
): void {
  if (Array.isArray(node)) {
    for (const child of node) walkWithParent(child, parent, ancestors, visit);
    return;
  }
  if (!isAstNode(node)) return;
  visit(node, parent, ancestors);
  for (const value of Object.values(node)) walkWithParent(value, node, [...ancestors, node], visit);
}

function referencesTransport(node: AstNode): boolean {
  if (node.type === 'Identifier') return node['name'] === TRANSPORT;
  if (node.type !== 'MemberExpression') return false;
  const property = node['property'];
  if (!isAstNode(property)) return false;
  const name = property.type === 'Identifier' ? property['name'] : property['value'];
  return name === TRANSPORT;
}

/**
 * The reviewed positions, each named. Handing the transport to an arbitrary callee is a
 * bypass — that callee can rename the parameter and dispatch — so a call argument is
 * legitimate only for the client-transport factory. Object properties are reviewed
 * only when they belong to an exact construction call (or the one default dependency
 * record), never merely because their key happens to be named `transport`.
 */
const TRANSPORT_FACTORY_CALLEES = new Set(['createClientDaemonTransport']);
const TRANSPORT_PROPERTY_CALLEES = new Set([
  'createCliDaemonTransport',
  'sendInjectedDaemonRequest',
]);
const CLI_MODULE = 'src/cli.ts';

function propertyKeyName(node: AstNode): string | undefined {
  const key = node['key'];
  if (!isAstNode(key)) return undefined;
  const name = key.type === 'Identifier' ? key['name'] : key['value'];
  return typeof name === 'string' ? name : undefined;
}

function identifierCalleeName(node: AstNode): string | undefined {
  const callee = node['callee'];
  return isAstNode(callee) && callee.type === 'Identifier' ? String(callee['name']) : undefined;
}

function identifierName(node: unknown): string | undefined {
  return isAstNode(node) && (node.type === 'Identifier' || node.type === 'BindingIdentifier')
    ? String(node['name'])
    : undefined;
}

function isReviewedTransportCallProperty(
  key: string | undefined,
  object: AstNode | undefined,
  owner: AstNode | undefined,
): boolean {
  return (
    key === 'transport' &&
    object?.type === 'ObjectExpression' &&
    owner?.type === 'CallExpression' &&
    TRANSPORT_PROPERTY_CALLEES.has(identifierCalleeName(owner) ?? '')
  );
}

function isDefaultCliDepsProperty(
  key: string | undefined,
  object: AstNode | undefined,
  owner: AstNode | undefined,
): boolean {
  if (key !== 'sendToDaemon' || object?.type !== 'ObjectExpression') return false;
  if (owner?.type !== 'VariableDeclarator') return false;
  const id = owner['id'];
  return (
    identifierName(id) === 'DEFAULT_CLI_DEPS' ||
    (isAstNode(id) && identifierName(id['pattern']) === 'DEFAULT_CLI_DEPS')
  );
}

function reviewedTransportProperty(
  filePath: string,
  parent: AstNode,
  ancestors: readonly AstNode[],
): boolean {
  if (filePath !== CLI_MODULE) return false;
  const key = propertyKeyName(parent);
  const object = ancestors.at(-2);
  const owner = ancestors.at(-3);
  return (
    isReviewedTransportCallProperty(key, object, owner) ||
    isDefaultCliDepsProperty(key, object, owner)
  );
}

/** The allowlist as data: parent node type -> what makes that position reviewed. */
const REVIEWED_TRANSPORT_POSITIONS: Readonly<Record<string, (parent: AstNode) => boolean>> = {
  ImportSpecifier: () => true,
  ImportDeclaration: () => true,
  TSTypeQuery: () => true,
  // The `deps.sendToDaemon` access itself; its own parent is checked in turn.
  MemberExpression: () => true,
  TSPropertySignature: (parent) => propertyKeyName(parent) === 'sendToDaemon',
};

function isReviewedTransportPosition(
  filePath: string,
  parent: AstNode | null,
  ancestors: readonly AstNode[],
): boolean {
  if (parent === null) return false;
  if (parent.type === 'Property') return reviewedTransportProperty(filePath, parent, ancestors);
  if (parent.type === 'CallExpression') {
    return (
      filePath === CLI_MODULE && TRANSPORT_FACTORY_CALLEES.has(identifierCalleeName(parent) ?? '')
    );
  }
  return REVIEWED_TRANSPORT_POSITIONS[parent.type]?.(parent) ?? false;
}

function referencesTransportNode(value: unknown): boolean {
  return isAstNode(value) && referencesTransport(value);
}

function transportDefect(
  filePath: string,
  node: AstNode,
  parent: AstNode | null,
  ancestors: readonly AstNode[],
): string | undefined {
  if (node.type === 'CallExpression' && referencesTransportNode(node['callee'])) {
    return `calls ${TRANSPORT} outside the injected-dispatch seam`;
  }
  if (node.type === 'VariableDeclarator') {
    return referencesTransportNode(node['init'])
      ? `aliases ${TRANSPORT} outside the injected-dispatch seam`
      : undefined;
  }
  if (node.type !== 'Identifier' && node.type !== 'MemberExpression') return undefined;
  if (!referencesTransport(node) || isReviewedTransportPosition(filePath, parent, ancestors)) {
    return undefined;
  }
  return `names ${TRANSPORT} in an unreviewed position`;
}

function transportMisuse(filePath: string, source: string): string[] {
  const misuse: string[] = [];
  walkWithParent(parseSync(filePath, source).program, null, [], (node, parent, ancestors) => {
    const defect = transportDefect(filePath, node, parent, ancestors);
    if (defect !== undefined) misuse.push(`${filePath}: ${defect}`);
  });
  return misuse;
}

function cliModulePaths(): string[] {
  const walkDir = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkDir(full);
      return entry.isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
    });
  return [CLI_ROOT, ...walkDir(CLI_DIR)].filter((file) => file !== SEAM_MODULE);
}

describe('platform-execution coherence across CLI route delegation', () => {
  test('no none command dispatches a platform-executing command', () => {
    expect(dominanceFailures(registryKind)).toEqual([]);
  });

  test('planted red: react-devtools declared none is rejected by the declared pair', () => {
    const plantedNone: PlatformExecutionKindOf = (command) =>
      command === 'react-devtools' ? 'none' : registryKind(command);

    expect(dominanceFailures(plantedNone)).toEqual([
      'react-devtools declares platformExecution none but its CLI route dispatches runtime (legacy)',
    ]);
  });

  test('the declared table still carries the react-devtools runtime delegation', () => {
    const route: CliInjectedRoute = 'react-devtools';
    expect(CLI_INJECTED_DAEMON_DISPATCHES[route]).toEqual(['runtime']);
  });

  test('every declared pair names registered commands on both ends', () => {
    expect(unresolvedPairs(registryKind)).toEqual([]);
  });

  test('planted red: a cast-around table target is reported, not read as no failure', () => {
    const planted = { 'react-devtools': ['not-a-command'] } as const;

    // Dominance alone cannot see it: an unknown command has no mode to compare.
    expect(dominanceFailures(registryKind, planted)).toEqual([]);
    expect(unresolvedPairs(registryKind, planted)).toEqual([
      'react-devtools dispatches not-a-command, which is not a registered command',
    ]);
  });

  test('the CLI reaches the daemon transport only through the injected-dispatch seam', () => {
    const misuse = cliModulePaths().flatMap((file) =>
      transportMisuse(path.relative(process.cwd(), file), fs.readFileSync(file, 'utf8')),
    );
    expect(misuse).toEqual([]);
  });

  test.each([
    ['a direct call', 'await sendToDaemon({ command: INTERNAL_COMMANDS.runtime });'],
    ['a member call', 'await deps.sendToDaemon(request);'],
    ['a computed-member call', "await deps['sendToDaemon'](request);"],
    ['a variable envelope', 'const request = { command: x }; await deps.sendToDaemon(request);'],
    ['an alias', 'const send = deps.sendToDaemon; await send(request);'],
    ['a handoff to an arbitrary helper', 'await runInjected(deps.sendToDaemon, request);'],
    [
      'a handoff under the globally reviewed transport key',
      'await runInjected({ transport: deps.sendToDaemon });',
    ],
    ['a handoff under an unreviewed key', 'await runInjected({ send: deps.sendToDaemon });'],
    ['a bare re-export', 'export { sendToDaemon };'],
  ])('planted red: %s outside the seam is rejected', (_label, body) => {
    expect(
      transportMisuse('src/cli/planted.ts', `async function run(deps) { ${body} }`),
    ).not.toEqual([]);
  });

  test('wiring the transport into a client transport factory stays allowed', () => {
    const wiring = `
      import { sendToDaemon } from '../daemon/client/daemon-client.ts';
      type CliDeps = { sendToDaemon: typeof sendToDaemon };
      function build(deps: CliDeps) {
        return createCliDaemonTransport({ transport: deps.sendToDaemon });
      }
      function build2(deps: CliDeps) {
        return createClient({ transport: createClientDaemonTransport(deps.sendToDaemon) });
      }
      const DEFAULT_CLI_DEPS: CliDeps = { sendToDaemon };
      function inject(deps: CliDeps) {
        return sendInjectedDaemonRequest({ transport: deps.sendToDaemon });
      }
    `;
    expect(transportMisuse(CLI_MODULE, wiring)).toEqual([]);
  });

  test('a trusted callee name on an arbitrary member cannot smuggle the transport', () => {
    const planted = `
      async function run(deps) {
        return helpers.createCliDaemonTransport({ transport: deps.sendToDaemon });
      }
    `;
    expect(transportMisuse(CLI_MODULE, planted)).not.toEqual([]);
  });

  test('the CLI module cannot hand off the transport through a generically named property', () => {
    const planted = `
      async function run(deps) {
        return runInjected({ transport: deps.sendToDaemon });
      }
    `;
    expect(transportMisuse(CLI_MODULE, planted)).not.toEqual([]);
  });
});
