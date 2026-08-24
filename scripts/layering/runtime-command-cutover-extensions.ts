import { parseSync } from 'oxc-parser';
import { propertyName, visitAst, type ProductionSource } from './cutover-policy-ast.ts';
import { lineOf } from './runtime-command-cutover-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

export {
  applicationLifecycleDurableResourceViolations,
  closeLifecycleRouteBindingViolations,
  openLifecycleRouteBindingViolations,
  prepareLifecycleRouteBindingViolations,
  runtimeLifecycleRouteBindingViolations,
} from './runtime-command-cutover-lifecycle.ts';

type AstNode = Record<string, unknown>;

const DEVICES_HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';
const DEVICES_INVENTORY_IMPORT_SOURCES = new Set([
  '../../request/device-inventory-context.ts',
  '../../core/dispatch-resolve.ts',
]);
const DEVICES_GATEWAY_BINDING = 'listDeviceInventory';
const APP_LOG_SESSION_STATE_OWNERS = new Set([
  'src/daemon/app-log-session-resource.ts',
  'src/daemon/types.ts',
]);
const APP_STATE_HANDLER_FILE = 'src/daemon/handlers/session-state.ts';
const APP_STATE_LEGACY_IMPORT_SOURCES = new Set([
  '../../platforms/android/app-lifecycle.ts',
  '../../platforms/harmonyos/app-lifecycle.ts',
]);
const APP_STATE_LEGACY_CALLS = new Set(['getAndroidAppState', 'getHarmonyAppState']);

/**
 * `devices` proves its single inventory route by binding identity, not by name: the
 * handler must import the neutral gateway, must not shadow the binding it imported, and
 * must actually call it. No other migrated command routes through a named gateway
 * binding, so this stays a row extension rather than a table column.
 */
export function devicesGatewayBindingViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(DEVICES_HANDLER_FILE);
  if (source === undefined) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: 1,
        message: 'devices gateway-owned handler module is missing',
      },
    ];
  }
  const program = parseSync(DEVICES_HANDLER_FILE, source).program as AstNode;
  const binding = importedGatewayBinding(program);
  if (binding === undefined) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: 1,
        message: `devices handler must import ${DEVICES_GATEWAY_BINDING} from the neutral inventory owner`,
      },
    ];
  }
  const shadow = shadowingBindingSite(program, binding);
  if (shadow !== undefined) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: lineOf(source, shadow),
        message: `devices handler shadows its imported ${DEVICES_GATEWAY_BINDING} binding`,
      },
    ];
  }
  if (!callsBinding(program, binding)) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: 1,
        message: `devices handler must call its imported ${DEVICES_GATEWAY_BINDING} binding`,
      },
    ];
  }
  return [];
}

/**
 * The app-log session record has one whole-record replacement owner (ADR 0019 §4-5).
 * `logs` is the durable-resource pilot; request-scoped rows own no session record, so
 * this stays a row extension.
 */
export function appLogSessionStateOwnershipViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  for (const file of productionSources(sources)) {
    if (!file.path.startsWith('src/daemon/') || APP_LOG_SESSION_STATE_OWNERS.has(file.path)) {
      continue;
    }
    const program = parseSync(file.path, file.source).program as AstNode;
    visitAst(program, (node) => {
      if (node['type'] !== 'Property' || node['kind'] !== 'init' || node['computed'] === true) {
        return;
      }
      const field = propertyName(node['key']);
      if (
        (field === 'appLog' || field === 'appLogFailure') &&
        !isAppLogTeardownDiscriminant(field, node['value'])
      ) {
        violations.push({
          file: file.path,
          line: lineOf(file.source, node),
          message: `session ${field} record constructed outside its owner`,
        });
      }
    });
  }
  return violations;
}

/**
 * Source-executed TypeScript must stay parseable by the Node 22 type-stripping runtime.
 * Not command-specific: it is declared on the logs row so its violations carry R14, the
 * id the layering report groups them under.
 */
export function sourceExecutedUsingDeclarationViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  for (const file of productionSources(sources)) {
    const program = parseSync(file.path, file.source).program as AstNode;
    visitAst(program, (node) => {
      if (
        node['type'] === 'VariableDeclaration' &&
        (node['kind'] === 'using' || node['kind'] === 'await using')
      ) {
        violations.push({
          file: file.path,
          line: lineOf(file.source, node),
          message: `source-executed TypeScript uses unsupported ${String(node['kind'])} declaration`,
        });
      }
    });
  }
  return violations;
}

/**
 * `appstate` retires the handler's direct Android/Harmony lifecycle dispatch. Other
 * daemon commands still use those helpers, so the proof is deliberately scoped to the
 * appstate handler instead of claiming a repository-wide symbol deletion.
 */
export function appStateLegacySessionHandlerViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(APP_STATE_HANDLER_FILE);
  if (source === undefined) {
    return [
      {
        file: APP_STATE_HANDLER_FILE,
        line: 1,
        message: 'appstate handler module is missing',
      },
    ];
  }
  const violations: UnruledViolation[] = [];
  const program = parseSync(APP_STATE_HANDLER_FILE, source).program as AstNode;
  visitAst(program, (node) => {
    if (node['type'] === 'ImportDeclaration') {
      const importSource = (node['source'] as AstNode | undefined)?.['value'];
      if (typeof importSource === 'string' && APP_STATE_LEGACY_IMPORT_SOURCES.has(importSource)) {
        violations.push({
          file: APP_STATE_HANDLER_FILE,
          line: lineOf(source, node),
          message: 'appstate handler imports a legacy platform app-state module',
        });
      }
      return;
    }
    if (
      node['type'] === 'CallExpression' &&
      APP_STATE_LEGACY_CALLS.has(identifierName(node['callee']) ?? '')
    ) {
      violations.push({
        file: APP_STATE_HANDLER_FILE,
        line: lineOf(source, node),
        message: 'appstate handler calls a legacy platform app-state backend',
      });
    }
  });
  return violations;
}

function productionSources(sources: ReadonlyMap<string, string>): ProductionSource[] {
  return [...sources].map(([path, source]) => ({ path, source }));
}

function isAppLogTeardownDiscriminant(field: string, valueNode: unknown): boolean {
  if (field !== 'appLog' || valueNode === null || typeof valueNode !== 'object') return false;
  const value = valueNode as AstNode;
  return (
    value['type'] === 'Literal' &&
    (value['value'] === 'run' || value['value'] === 'already-settled')
  );
}

function importedGatewayBinding(program: AstNode): string | undefined {
  const body = program['body'];
  if (!Array.isArray(body)) return undefined;
  for (const statement of body as AstNode[]) {
    if (statement['type'] !== 'ImportDeclaration') continue;
    const source = statement['source'] as AstNode | undefined;
    const specifier = source === undefined ? undefined : source['value'];
    if (typeof specifier !== 'string' || !DEVICES_INVENTORY_IMPORT_SOURCES.has(specifier)) continue;
    const specifiers = statement['specifiers'];
    if (!Array.isArray(specifiers)) continue;
    for (const imported of specifiers as AstNode[]) {
      if (
        imported['type'] === 'ImportSpecifier' &&
        identifierName(imported['imported']) === DEVICES_GATEWAY_BINDING
      ) {
        return identifierName(imported['local']);
      }
    }
  }
  return undefined;
}

function callsBinding(program: AstNode, binding: string): boolean {
  let called = false;
  visitAst(program, (node) => {
    if (node['type'] === 'CallExpression' && identifierName(node['callee']) === binding) {
      called = true;
    }
  });
  return called;
}

function shadowingBindingSite(program: AstNode, binding: string): AstNode | undefined {
  let found: AstNode | undefined;
  visitAst(program, (node) => {
    if (found !== undefined) return;
    if (
      node['type'] === 'VariableDeclarator' ||
      node['type'] === 'FunctionDeclaration' ||
      node['type'] === 'FunctionExpression' ||
      node['type'] === 'ClassDeclaration' ||
      node['type'] === 'ClassExpression'
    ) {
      if (patternBinds(node['id'], binding)) found = node;
      if (found === undefined && bindsInParams(node, binding)) found = node;
      return;
    }
    if (node['type'] === 'ArrowFunctionExpression' && bindsInParams(node, binding)) {
      found = node;
      return;
    }
    if (node['type'] === 'CatchClause' && patternBinds(node['param'], binding)) found = node;
  });
  return found;
}

function bindsInParams(node: AstNode, binding: string): boolean {
  const params = node['params'];
  return Array.isArray(params) && params.some((param) => patternBinds(param, binding));
}

function patternBinds(node: unknown, binding: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as AstNode;
  if (record['type'] === 'Identifier') return record['name'] === binding;
  if (record['type'] === 'RestElement') return patternBinds(record['argument'], binding);
  if (record['type'] === 'AssignmentPattern') return patternBinds(record['left'], binding);
  if (record['type'] === 'TSParameterProperty') return patternBinds(record['parameter'], binding);
  if (record['type'] === 'ArrayPattern') {
    const elements = record['elements'];
    return Array.isArray(elements) && elements.some((element) => patternBinds(element, binding));
  }
  if (record['type'] === 'ObjectPattern') {
    const properties = record['properties'];
    return (
      Array.isArray(properties) &&
      properties.some((property) => {
        if (property === null || typeof property !== 'object') return false;
        const entry = property as AstNode;
        return entry['type'] === 'Property'
          ? patternBinds(entry['value'], binding)
          : patternBinds(entry['argument'], binding);
      })
    );
  }
  return false;
}

function identifierName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as AstNode;
  return record['type'] === 'Identifier' && typeof record['name'] === 'string'
    ? record['name']
    : undefined;
}
