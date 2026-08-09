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

function identifierName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'Identifier') return record['name'] as string | undefined;
  if (record['type'] === 'MemberExpression') return identifierName(record['property']);
  return undefined;
}

function isFunction(node: Record<string, unknown>): boolean {
  return (
    node['type'] === 'FunctionDeclaration' ||
    node['type'] === 'FunctionExpression' ||
    node['type'] === 'ArrowFunctionExpression'
  );
}

function eagerMechanicSites(source: string): number[] {
  const sites: number[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (isFunction(record)) return;
    const type = record['type'];
    const callee = type === 'CallExpression' || type === 'NewExpression' ? record['callee'] : null;
    const name = identifierName(callee);
    const isEagerCall =
      type === 'CallExpression' &&
      name !== undefined &&
      /^(?:existsSync|accessSync|statSync|readFileSync|readdirSync|fetch|probe\w*|prepare\w*|build\w*)$/i.test(
        name,
      );
    const isHelperConstruction =
      type === 'NewExpression' && name !== undefined && /(?:Helper|Manager|Runner)$/.test(name);
    if (isEagerCall || isHelperConstruction) {
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
    specifier === './platform-runtime-device-inventory.ts' ||
    specifier === './platform-runtime-host.ts' ||
    specifier.startsWith('./platform-runtime-host/')
  );
}

export function checkPlatformComposition(
  source: string | undefined,
  expectedMetadataNames: readonly string[],
): LayeringViolation[] {
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

  const call = /createPlatformModuleRegistry\s*\(\s*\[([\s\S]*?)\]\s*\)/.exec(source);
  const registered = (call?.[1] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (
    registered.length !== expectedMetadataNames.length ||
    registered.some((name, index) => name !== expectedMetadataNames[index])
  ) {
    violations.push(
      violation(
        1,
        `registration list must be exactly [${expectedMetadataNames.join(', ')}], found [${registered.join(', ')}]`,
      ),
    );
  }

  for (const line of eagerMechanicSites(source)) {
    violations.push(
      violation(
        line,
        'composition may not probe the host, prepare assets, or construct helpers before selected use',
      ),
    );
  }
  return violations;
}
