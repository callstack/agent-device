import { parseSync } from 'oxc-parser';

const CHECK_BINDING = /^check[A-Z]/;

/**
 * Every guard rule reaches `report()` through one hand-written array in `main()`, and nothing else
 * enumerates them: a lost spread silently retires a rule while the run still prints OK, and a
 * duplicated one double-counts and double-annotates every finding it makes. Neither is visible to
 * the per-policy tests, which call their rule functions directly and never see the wiring.
 *
 * So the array must hold each in-scope `check*` binding — declared here or imported — exactly once.
 */
export function ruleWiringViolations(source: string): string[] {
  const parsed = parseSync('check.ts', source);
  const spreads = violationListSpreads(parsed.program.body);
  if (spreads === undefined) {
    return [
      'main() does not hold a `const violations = [...]` array of spread check* calls — the wiring ' +
        'guard cannot read the rule list. Restore that shape, or move this check to whatever now ' +
        'enumerates the rules.',
    ];
  }

  const violations: string[] = [];
  const counts = new Map<string, number>();
  for (const name of spreads) counts.set(name, (counts.get(name) ?? 0) + 1);

  for (const [name, count] of counts) {
    if (count > 1) {
      violations.push(
        `${name} is spread into main()'s violation list ${count} times, so every finding it ` +
          `reports is printed and ::error-annotated ${count} times. Keep one.`,
      );
    }
  }
  for (const name of checkBindings(parsed)) {
    if (counts.has(name)) continue;
    violations.push(
      `${name} is in scope but never spread into main()'s violation list, so the rule it owns is ` +
        'silently unenforced — the guard still prints OK. Wire it in, delete it, or rename it if ' +
        'it is a helper rather than a rule.',
    );
  }
  return violations;
}

/** Spread callee names in `main()`'s violation list, or undefined when that shape is gone. */
function violationListSpreads(body: readonly unknown[]): string[] | undefined {
  const main = body
    .map((statement) => declarationOf(statement))
    .find((node) => node?.type === 'FunctionDeclaration' && identifierName(node.id) === 'main');
  const statements = asNode(asNode(main?.body)?.body);
  if (!Array.isArray(statements)) return undefined;

  for (const statement of statements) {
    const node = asNode(statement);
    if (node?.type !== 'VariableDeclaration' || !Array.isArray(node.declarations)) continue;
    for (const entry of node.declarations) {
      const declarator = asNode(entry);
      if (identifierName(declarator?.id) !== 'violations') continue;
      const init = asNode(declarator?.init);
      if (init?.type !== 'ArrayExpression' || !Array.isArray(init.elements)) return undefined;
      return init.elements.flatMap((element) => {
        const spread = asNode(element);
        if (spread?.type !== 'SpreadElement') return [];
        const call = asNode(spread.argument);
        if (call?.type !== 'CallExpression') return [];
        const name = identifierName(call.callee);
        return name === undefined ? [] : [name];
      });
    }
  }
  return undefined;
}

/** Value bindings named `check*`: rules declared in this file, plus rules imported from a policy. */
function checkBindings(parsed: ReturnType<typeof parseSync>): string[] {
  const names: string[] = [];
  for (const statement of parsed.program.body) {
    const declaration = declarationOf(statement);
    if (declaration?.type !== 'FunctionDeclaration') continue;
    const name = identifierName(declaration.id);
    if (name !== undefined && CHECK_BINDING.test(name)) names.push(name);
  }
  for (const entry of parsed.module.staticImports) {
    for (const imported of entry.entries) {
      // A type-only import names no rule to run, so it carries no wiring obligation.
      if (imported.isType) continue;
      const name = imported.localName.value;
      if (CHECK_BINDING.test(name)) names.push(name);
    }
  }
  return names;
}

/** The statement itself, or what it declares when it is wrapped in an export. */
function declarationOf(statement: unknown): Record<string, unknown> | undefined {
  const node = asNode(statement);
  return node?.type === 'ExportNamedDeclaration' ? asNode(node.declaration) : node;
}

function identifierName(value: unknown): string | undefined {
  const node = asNode(value);
  if (node?.type !== 'Identifier' || typeof node.name !== 'string') return undefined;
  return node.name;
}

function asNode(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}
