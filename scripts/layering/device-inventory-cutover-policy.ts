import { parseSync } from 'oxc-parser';
import type { LayeringViolation } from './model.ts';

const RULE = 'R17 device-inventory-cutover';
const HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';
const INVENTORY_IMPORT_SOURCES = new Set([
  '../../core/device-inventory-context.ts',
  '../../core/dispatch-resolve.ts',
]);
const LEGACY_INVENTORY_IDENTIFIERS = new Set([
  'discoverDevices',
  'listAndroidDevices',
  'listAppleDevices',
  'listHarmonyDevices',
  'listHarmonyOsDevices',
  'listLinuxDevices',
  'listMacosDevices',
  'listVegaDevices',
  'listWebDevices',
]);

type AstNode = Record<string, unknown>;

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: RULE, file, line, message };
}

function lineOf(source: string, node: AstNode): number {
  return source.slice(0, (node['start'] as number | undefined) ?? 0).split('\n').length;
}

function identifierName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as AstNode;
  return record['type'] === 'Identifier' && typeof record['name'] === 'string'
    ? record['name']
    : undefined;
}

function literalString(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const value = (node as AstNode)['value'];
  return typeof value === 'string' ? value : undefined;
}

function visitAst(node: unknown, visitor: (node: AstNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitAst(child, visitor);
    return;
  }
  const record = node as AstNode;
  visitor(record);
  for (const value of Object.values(record)) visitAst(value, visitor);
}

function isLegacyInventoryModulePath(file: string): boolean {
  return (
    file === 'src/core/platform-inventory.ts' ||
    /^src\/platforms\/(?:[^/]+\/)*devices\.ts$/.test(file)
  );
}

function isLegacyInventoryImport(specifier: string): boolean {
  return (
    /(?:^|\/)core\/platform-inventory(?:\.[cm]?[jt]s)?$/.test(specifier) ||
    /(?:^|\/)platforms\/(?:[^/]+\/)*devices(?:\.[cm]?[jt]s)?$/.test(specifier)
  );
}

function importedModuleSpecifier(node: AstNode): string | undefined {
  if (
    node['type'] === 'ImportDeclaration' ||
    node['type'] === 'ImportExpression' ||
    node['type'] === 'ExportNamedDeclaration' ||
    node['type'] === 'ExportAllDeclaration'
  ) {
    return literalString(node['source']);
  }
  return undefined;
}

function importedInventoryBinding(program: AstNode): string | undefined {
  const body = program['body'];
  if (!Array.isArray(body)) return undefined;
  for (const statement of body as AstNode[]) {
    if (statement['type'] !== 'ImportDeclaration') continue;
    const specifier = literalString(statement['source']);
    if (!specifier || !INVENTORY_IMPORT_SOURCES.has(specifier)) continue;
    const importSpecifiers = statement['specifiers'];
    if (!Array.isArray(importSpecifiers)) continue;
    for (const imported of importSpecifiers as AstNode[]) {
      if (
        imported['type'] === 'ImportSpecifier' &&
        identifierName(imported['imported']) === 'listDeviceInventory'
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

function shadowingBindingSite(program: AstNode, binding: string): AstNode | undefined {
  let found: AstNode | undefined;
  visitAst(program, (node) => {
    if (found) return;
    if (
      node['type'] === 'VariableDeclarator' ||
      node['type'] === 'FunctionDeclaration' ||
      node['type'] === 'FunctionExpression' ||
      node['type'] === 'ClassDeclaration' ||
      node['type'] === 'ClassExpression'
    ) {
      if (patternBinds(node['id'], binding)) found = node;
      if (
        !found &&
        Array.isArray(node['params']) &&
        node['params'].some((param) => patternBinds(param, binding))
      ) {
        found = node;
      }
      return;
    }
    if (node['type'] === 'ArrowFunctionExpression') {
      if (
        Array.isArray(node['params']) &&
        node['params'].some((param) => patternBinds(param, binding))
      ) {
        found = node;
      }
      return;
    }
    if (node['type'] === 'CatchClause' && patternBinds(node['param'], binding)) found = node;
  });
  return found;
}

function checkHandlerRoute(source: string | undefined): LayeringViolation[] {
  if (source === undefined) {
    return [violation(HANDLER_FILE, 1, 'devices gateway-owned handler module is missing')];
  }
  const program = parseSync(HANDLER_FILE, source).program as AstNode;
  const binding = importedInventoryBinding(program);
  if (!binding) {
    return [
      violation(
        HANDLER_FILE,
        1,
        'devices handler must import listDeviceInventory from the neutral inventory owner',
      ),
    ];
  }
  const shadow = shadowingBindingSite(program, binding);
  if (shadow) {
    return [
      violation(
        HANDLER_FILE,
        lineOf(source, shadow),
        'devices handler shadows its imported listDeviceInventory binding',
      ),
    ];
  }
  if (!callsBinding(program, binding)) {
    return [
      violation(
        HANDLER_FILE,
        1,
        'devices handler must call its imported listDeviceInventory binding',
      ),
    ];
  }
  return [];
}

function checkLegacyRoutes(file: string, source: string): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  if (isLegacyInventoryModulePath(file)) {
    violations.push(violation(file, 1, 'legacy device inventory module path remains'));
  }
  const program = parseSync(file, source).program as AstNode;
  const seenIdentifiers = new Set<string>();
  visitAst(program, (node) => {
    const specifier = importedModuleSpecifier(node);
    if (specifier && isLegacyInventoryImport(specifier)) {
      violations.push(
        violation(
          file,
          lineOf(source, node),
          `production source imports legacy device inventory module '${specifier}'`,
        ),
      );
    }
    if (node['type'] !== 'Identifier') return;
    const name = identifierName(node);
    if (!name || !LEGACY_INVENTORY_IDENTIFIERS.has(name) || seenIdentifiers.has(name)) return;
    seenIdentifiers.add(name);
    violations.push(
      violation(
        file,
        lineOf(source, node),
        `legacy device inventory identifier '${name}' remains in production code`,
      ),
    );
  });
  return violations;
}

export function checkDeviceInventoryCutover(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  return [
    ...checkHandlerRoute(sources.get(HANDLER_FILE)),
    ...[...sources].flatMap(([file, source]) => checkLegacyRoutes(file, source)),
  ];
}

export function deviceInventoryCutoverSummary(): string {
  return 'R17 holds the devices command to one gateway-owned inventory route with no legacy route';
}
