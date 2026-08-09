import { parseSync } from 'oxc-parser';
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
    }
    for (const value of Object.values(record)) visit(value, depth);
  };
  visit(parseSync(file, source).program, 0);
  return violations;
}
