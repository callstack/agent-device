// Catches: a substrate package (capture-kit and peers) dispatching through request-scoped
//   async_hooks, or a retired src/contracts/ production file reappearing — either one re-mixes
//   request-bound state into durable capture code, which type-checks fine because async_hooks
//   and the retired path are both ordinary, legal imports from where the violation happens.
// Evidence: e832325e87 (#2088) split host mechanics into the host-kit capability ports this
//   rule keeps request-scoped dispatch out of.
// Cost: 170 LOC (110 rule + 60 test).
// Kill criterion: none enforced today; retire only by maintainer decision that capture-kit staying
//   free of request-scoped dispatch, and src/contracts/ staying retired, no longer matter.
//   package.json cannot replace it: node:async_hooks is a built-in, not a dependency, and no
//   manifest governs a tracked path under src/contracts/.

import { parseSync } from 'oxc-parser';
import type { LayeringViolation } from './model.ts';

export const SUBSTRATE_DOMAIN_SHAPE_RULE = 'R70 substrate-domain-shape';

export type SubstrateDomainSource = Readonly<{ path: string; source: string }>;

const ASYNC_HOOKS = /^(?:node:)?async_hooks(?:\/|$)/;

/** Capture-kit is durable capture; request ALS and retired src/contracts/ stay out of substrate packages. */
export function substrateDomainShapeViolations(
  sources: readonly SubstrateDomainSource[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of sources) {
    if (isRetiredContractsRoot(file.path)) {
      violations.push(
        violation(
          file.path,
          1,
          'src/contracts/ is retired; vocabulary lives in packages/contracts, and executable policy belongs to its owning domain',
        ),
      );
      continue;
    }
    if (!isCaptureKitProduction(file.path)) continue;
    const parsed = parseSync(file.path, file.source);
    for (const site of moduleSpecifiers(parsed.module, file.source)) {
      if (!ASYNC_HOOKS.test(site.spec)) continue;
      violations.push(
        violation(
          file.path,
          site.line,
          `capture-kit imports '${site.spec}'; request-scoped AsyncLocalStorage dispatch belongs in src/request`,
        ),
      );
    }
    visit(parsed.program, (node) => {
      if (!isAsyncLocalStorageConstruction(node)) return;
      violations.push(
        violation(
          file.path,
          lineAt(file.source, Number(node.start ?? 0)),
          'capture-kit constructs AsyncLocalStorage; request-scoped dispatch belongs in src/request',
        ),
      );
    });
  }
  return violations;
}

function isRetiredContractsRoot(file: string): boolean {
  return file.startsWith('src/contracts/') && file.endsWith('.ts');
}

function isCaptureKitProduction(file: string): boolean {
  return (
    file.startsWith('packages/capture-kit/src/') &&
    !file.endsWith('.test.ts') &&
    !file.includes('/__tests__/')
  );
}

function isAsyncLocalStorageConstruction(node: Record<string, unknown>): boolean {
  if (node.type !== 'NewExpression') return false;
  const callee = node.callee;
  if (callee === null || typeof callee !== 'object') return false;
  const expression = callee as Record<string, unknown>;
  return expression.type === 'Identifier' && expression.name === 'AsyncLocalStorage';
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

function violation(file: string, line: number, message: string): LayeringViolation {
  return { rule: SUBSTRATE_DOMAIN_SHAPE_RULE, file, line, message };
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
