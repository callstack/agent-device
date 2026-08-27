import { parseSync } from 'oxc-parser';
import { parseImports, type LayeringViolation } from './model.ts';

const COMPOSITION_FILE = 'src/platform-runtime.ts';
const RULE = 'R13 platform-package-substrate';

function violation(line: number, message: string): LayeringViolation {
  return { rule: RULE, file: COMPOSITION_FILE, line, message };
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function memberPropertyName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'ChainExpression') return memberPropertyName(record['expression']);
  if (record['type'] !== 'MemberExpression') return undefined;
  const property = record['property'] as Record<string, unknown> | undefined;
  if (property?.['type'] === 'Identifier') return property['name'] as string | undefined;
  const value = property?.['value'];
  return typeof value === 'string' ? value : undefined;
}

function isFunction(node: Record<string, unknown>): boolean {
  return (
    node['type'] === 'FunctionDeclaration' ||
    node['type'] === 'FunctionExpression' ||
    node['type'] === 'ArrowFunctionExpression'
  );
}

function eagerImplementationLoaderSites(source: string): number[] {
  const sites: number[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (isFunction(record)) return;
    if (
      record['type'] === 'CallExpression' &&
      ['loadInventory', 'loadRuntime'].includes(memberPropertyName(record['callee']) ?? '')
    ) {
      sites.push(lineOf(source, (record['start'] as number | undefined) ?? 0));
      return;
    }
    for (const value of Object.values(record)) visit(value);
  };
  visit(parseSync(COMPOSITION_FILE, source).program);
  return sites;
}

function isAllowedCompositionImport(specifier: string): boolean {
  return (
    /^@agent-device\/contracts(?:\/|$)/.test(specifier) ||
    /^@agent-device\/platform-[^/]+$/.test(specifier) ||
    specifier === './platform-runtime-gateway.ts' ||
    specifier === './platform-runtime-android-observation-host.ts' ||
    specifier === './platform-runtime-operation-host.ts' ||
    specifier === './platform-runtime-app-state-host.ts' ||
    specifier === './platform-runtime-device-inventory.ts' ||
    specifier === './platform-runtime-host.ts' ||
    specifier === './platform-runtime/request-providers.ts' ||
    specifier.startsWith('./platform-runtime-host/')
  );
}

export function checkPlatformComposition(source: string | undefined): LayeringViolation[] {
  if (source === undefined) {
    return [violation(1, 'the exact platform composition root is missing')];
  }
  const violations: LayeringViolation[] = [];
  for (const site of parseImports(source)) {
    if (!isAllowedCompositionImport(site.spec)) {
      violations.push(
        violation(
          site.line,
          `composition imports only runtime contracts, host-capability adapters, and concrete platform facades; found '${site.spec}'`,
        ),
      );
    }
    if (/^@agent-device\/platform-/.test(site.spec) && (site.dynamic || site.typeOnly)) {
      violations.push(
        violation(site.line, 'platform inventory modules must be statically composed'),
      );
    }
  }

  for (const line of eagerImplementationLoaderSites(source)) {
    violations.push(
      violation(
        line,
        'composition may not invoke a platform implementation loader before selected use',
      ),
    );
  }
  return violations;
}
