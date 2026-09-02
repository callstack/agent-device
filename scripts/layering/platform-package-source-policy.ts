// Catches: a platform package touching ambient host state (fs, os, process) directly instead
//   of through capture-kit's declared ports — a substrate leak that lets a platform module read
//   or mutate host state the request-scoped runtime cannot account for, invisible to a type
//   check because the ambient APIs are fully typed and legal to call.
// Evidence: c06bed9f77 (#1699) extracted platform device inventory runtime, the first substrate
//   split this rule started policing; d76e0f94e9 (#1779) migrated snapshot the same way.
// Cost: 230 LOC (157 rule + 73 test); shares rule id R13 with platform-package-policy.ts (1030
//   LOC) and platform-composition-policy.ts (103 LOC).
// Kill criterion: none enforced today; retire only by maintainer decision that platform packages
//   keeping host access (ambient fs/os/process imports, host state at module evaluation, xcrun
//   outside appleTools) behind capture-kit ports no longer matters. Typed ports do not make the
//   ambient imports unresolvable: @types/node stays in scope for every platform tsconfig, and
//   the A4 spike found it must (platform-apple's runner subtree legitimately uses fs/net/os).

import { parseSync } from 'oxc-parser';
import { memberPath } from './layering-ast.ts';
import { parseImports, type LayeringViolation } from './model.ts';

const RULE = 'R13 platform-package-substrate';
const AMBIENT_HOST_SPECIFIERS = new Set([
  'fs',
  'fs/promises',
  'node:fs',
  'node:fs/promises',
  'os',
  'node:os',
  'process',
  'node:process',
]);

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: RULE, file, line, message };
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function isFunction(node: Record<string, unknown>): boolean {
  return (
    node['type'] === 'FunctionDeclaration' ||
    node['type'] === 'FunctionExpression' ||
    node['type'] === 'ArrowFunctionExpression'
  );
}

function rootIdentifier(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'Identifier') return record['name'] as string | undefined;
  if (record['type'] === 'MemberExpression') return rootIdentifier(record['object']);
  if (record['type'] === 'ChainExpression') return rootIdentifier(record['expression']);
  return undefined;
}

function literalString(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const value = (node as Record<string, unknown>)['value'];
  return typeof value === 'string' ? value : undefined;
}

function objectPropertyValue(node: unknown, key: string): unknown {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record['type'] !== 'ObjectExpression' || !Array.isArray(record['properties']))
    return undefined;
  for (const property of record['properties'] as Array<Record<string, unknown>>) {
    if (property['type'] !== 'Property' || property['computed'] === true) continue;
    const propertyKey = property['key'] as Record<string, unknown> | undefined;
    const propertyName =
      propertyKey?.['type'] === 'Identifier' ? propertyKey['name'] : literalString(propertyKey);
    if (propertyName === key) return property['value'];
  }
  return undefined;
}

function routesXcrunThroughGenericCommands(node: Record<string, unknown>): boolean {
  if (node['type'] !== 'CallExpression') return false;
  const path = memberPath(node['callee']);
  if (!path || path.at(-2) !== 'commands') return false;
  const args = node['arguments'];
  if (!Array.isArray(args)) return false;
  if (path.at(-1) === 'which') return literalString(args[0]) === 'xcrun';
  return (
    path.at(-1) === 'run' && literalString(objectPropertyValue(args[0], 'executable')) === 'xcrun'
  );
}

export function checkPlatformPackageSourcePolicy(
  file: string,
  source: string,
  ownerFamily: string,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const facade = file === `packages/platform-${ownerFamily}/src/index.ts`;
  for (const site of parseImports(source)) {
    if (!AMBIENT_HOST_SPECIFIERS.has(site.spec)) continue;
    violations.push(
      violation(
        file,
        site.line,
        `platform-${ownerFamily} may not acquire ambient host authority from '${site.spec}'; inject inert configuration or a contract host port`,
      ),
    );
  }

  const visit = (node: unknown, deferredDepth: number): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, deferredDepth);
      return;
    }
    const record = node as Record<string, unknown>;
    const depth = isFunction(record) ? deferredDepth + 1 : deferredDepth;
    const type = record['type'];
    const line = lineOf(source, (record['start'] as number | undefined) ?? 0);

    if (facade && type === 'ImportExpression' && depth === 0) {
      violations.push(
        violation(
          file,
          line,
          `platform-${ownerFamily} facade dynamic import must be nested in a deferred function`,
        ),
      );
    }
    if (type === 'MemberExpression' && rootIdentifier(record) === 'process') {
      violations.push(
        violation(
          file,
          line,
          `platform-${ownerFamily} may not acquire ambient host authority from process; inject inert configuration or a contract host port`,
        ),
      );
      return;
    }
    if (type === 'CallExpression') {
      const calleeRoot = rootIdentifier(record['callee']);
      if (calleeRoot === 'fetch') {
        violations.push(
          violation(
            file,
            line,
            `platform-${ownerFamily} may not acquire ambient host authority from fetch; use a contract host port`,
          ),
        );
      }
      if (depth === 0 && calleeRoot === 'host') {
        violations.push(
          violation(
            file,
            line,
            `platform-${ownerFamily} may not probe the host at module evaluation; defer host-port calls until selected use`,
          ),
        );
      }
      if (ownerFamily === 'apple' && routesXcrunThroughGenericCommands(record)) {
        violations.push(
          violation(
            file,
            line,
            'platform-apple must route xcrun through the focused appleTools host port',
          ),
        );
      }
    }
    for (const value of Object.values(record)) visit(value, depth);
  };
  visit(parseSync(file, source).program, 0);
  return violations;
}
