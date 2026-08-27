import { parseSync } from 'oxc-parser';
import type { LayeringViolation } from './model.ts';

export type ContractsProductionSource = Readonly<{ path: string; source: string }>;

const RULE = 'R18 contracts-implementation-authority';
const FORBIDDEN_HOST_MODULES = /^(?:node:)?(?:child_process|fs|timers)(?:\/|$)/;
const FORBIDDEN_TIMER_CALLS = new Set([
  'clearImmediate',
  'clearInterval',
  'clearTimeout',
  'setImmediate',
  'setInterval',
  'setTimeout',
]);

/** Contracts owns vocabulary. Host/process/timer mechanics belong in capture-kit or an adapter. */
export function contractsImplementationAuthorityViolations(
  sources: readonly ContractsProductionSource[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of sources) {
    if (!isContractsProduction(file.path)) continue;
    const parsed = parseSync(file.path, file.source);
    const networkTrafficViolation = networkTrafficImplementationViolation(
      file.path,
      file.source,
      parsed.program.body,
    );
    if (file.path === 'packages/contracts/src/interaction-outcome.ts') {
      violations.push(
        violation(
          file.path,
          1,
          'contracts may not own mutable interaction-outcome lifecycle; that WeakMap identity map belongs in src/core',
        ),
      );
    }
    if (file.path === 'packages/contracts/src/snapshot-quality-warnings.ts') {
      violations.push(
        violation(
          file.path,
          1,
          'contracts may not own snapshot quality warning rendering; that presentation policy belongs in src/snapshot/snapshot-presentation',
        ),
      );
    }
    if (networkTrafficViolation) violations.push(networkTrafficViolation);
    for (const site of moduleSpecifiers(parsed.module, file.source)) {
      if (!FORBIDDEN_HOST_MODULES.test(site.spec)) continue;
      violations.push(
        violation(
          file.path,
          site.line,
          `contracts imports host implementation authority '${site.spec}'; move mechanics to @agent-device/capture-kit`,
        ),
      );
    }
    visit(parsed.program, (node) => {
      if (node.type !== 'CallExpression') return;
      const timerName = timerCallName(node.callee);
      if (!timerName) return;
      violations.push(
        violation(
          file.path,
          lineAt(file.source, Number(node.start ?? 0)),
          `contracts calls timer primitive '${timerName}'; move lifecycle mechanics to @agent-device/capture-kit`,
        ),
      );
    });
  }
  return violations;
}

function networkTrafficImplementationViolation(
  file: string,
  source: string,
  body: readonly unknown[],
): LayeringViolation | undefined {
  if (!file.startsWith('packages/contracts/src/network-traffic')) return undefined;
  if (file !== 'packages/contracts/src/network-traffic.ts') {
    return violation(
      file,
      1,
      'contracts may own only the neutral network-traffic vocabulary; parser modules belong in @agent-device/capture-kit',
    );
  }
  const implementation = body.find((statement) => !isTypeOnlyStatement(statement));
  if (!implementation || typeof implementation !== 'object') return undefined;
  return violation(
    file,
    lineAt(source, Number((implementation as Record<string, unknown>).start ?? 0)),
    'contracts network-traffic vocabulary contains runtime implementation; move parser mechanics to @agent-device/capture-kit',
  );
}

function isTypeOnlyStatement(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const statement = value as Record<string, unknown>;
  if (statement.type === 'ImportDeclaration') return statement.importKind === 'type';
  if (statement.type === 'TSTypeAliasDeclaration' || statement.type === 'TSInterfaceDeclaration') {
    return true;
  }
  if (statement.type !== 'ExportNamedDeclaration') return false;
  if (statement.exportKind === 'type') return true;
  const declaration = statement.declaration as Record<string, unknown> | undefined;
  return (
    declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration'
  );
}

function moduleSpecifiers(
  module: ReturnType<typeof parseSync>['module'],
  source: string,
): ReadonlyArray<{ spec: string; line: number }> {
  const sites: Array<{ spec: string; line: number }> = [];
  const add = (request: { value?: string; start?: number } | undefined): void => {
    if (request?.value)
      sites.push({ spec: request.value, line: lineAt(source, request.start ?? 0) });
  };
  for (const entry of module.staticImports) add(entry.moduleRequest);
  for (const entry of module.staticExports) {
    for (const exported of entry.entries) add(exported.moduleRequest);
  }
  for (const entry of module.dynamicImports) {
    const raw = source.slice(entry.moduleRequest.start, entry.moduleRequest.end);
    const literal = /^(['"])([^'"]*)\1$/.exec(raw);
    if (literal) sites.push({ spec: literal[2]!, line: lineAt(source, entry.moduleRequest.start) });
  }
  return sites;
}

function timerCallName(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const callee = value as Record<string, unknown>;
  if (callee.type === 'Identifier' && FORBIDDEN_TIMER_CALLS.has(String(callee.name))) {
    return String(callee.name);
  }
  if (callee.type !== 'MemberExpression' || callee.computed === true) return undefined;
  const object = callee.object as Record<string, unknown> | undefined;
  const property = callee.property as Record<string, unknown> | undefined;
  if (
    object?.type !== 'Identifier' ||
    !['global', 'globalThis', 'window'].includes(String(object.name)) ||
    property?.type !== 'Identifier' ||
    !FORBIDDEN_TIMER_CALLS.has(String(property.name))
  ) {
    return undefined;
  }
  return String(property.name);
}

function isContractsProduction(file: string): boolean {
  return (
    file.startsWith('packages/contracts/src/') &&
    !file.endsWith('.test.ts') &&
    !file.includes('/__tests__/')
  );
}

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: RULE, file, line, message };
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function visit(node: unknown, callback: (node: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, callback);
    return;
  }
  const record = node as Record<string, unknown>;
  callback(record);
  for (const value of Object.values(record)) visit(value, callback);
}
