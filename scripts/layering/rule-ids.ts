import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Rule-ID uniqueness.
 *
 * Layering rules are addressed by number in review, in CI annotations, and in
 * the code comments that point at them, so a number must name exactly one rule.
 * Two branches allocating the same free number do not conflict in git — the
 * files differ — and land as two rules answering to one id, after which every
 * reference to it is ambiguous. #1656 and #1750 both reached for R17.
 *
 * The claim being checked is about source text (which id a rule declares), so
 * reading the declarations IS the check rather than a proxy for one. It is a
 * naming registry, not a behavioural claim.
 */

export type RuleDeclaration = {
  id: string;
  name: string;
  file: string;
};

/**
 * A rule id is declared as a WHOLE string literal — `rule: 'R7 …'` at an
 * emitter, `const RULE = 'R17 …'` at the top of a policy module. Matching the
 * complete literal is what separates a declaration from the prose that also
 * names rules ("R17 holds the devices command to…"): a sentence keeps going
 * where a declaration closes its quote.
 */
const RULE_LITERAL = /'(R\d+) ([a-z0-9-]+)'/g;

export function collectRuleDeclarations(files: readonly { path: string; source: string }[]) {
  const declarations: RuleDeclaration[] = [];
  for (const file of files) {
    for (const match of file.source.matchAll(RULE_LITERAL)) {
      declarations.push({ id: match[1]!, name: match[2]!, file: file.path });
    }
  }
  return declarations;
}

export function duplicateRuleIds(declarations: readonly RuleDeclaration[]): string[] {
  const byId = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    const names = byId.get(declaration.id) ?? new Set<string>();
    names.add(declaration.name);
    byId.set(declaration.id, names);
  }
  return [...byId]
    .filter(([, names]) => names.size > 1)
    .map(([id, names]) => `${id} names ${[...names].sort().join(' and ')}`)
    .sort();
}

/**
 * Collisions that predate this gate: `main` reuses R11 and R13 for two rules
 * each, which #1750 is renaming to R17/R18. Transitional, and each entry
 * expires on contact — see `ruleIdCollisionFailures`. Empty is the end state,
 * and the gate gets there on its own.
 */
export const KNOWN_RULE_ID_COLLISIONS: readonly string[] = [
  'R11 names contracts-implementation-authority and package-boundaries',
  'R13 names device-inventory-cutover and platform-package-substrate',
];

/**
 * Both halves of the transition, because an allowance that outlives the thing
 * it allows fails OPEN: once #1750 renames R11/R13 apart, a list still naming
 * those exact collisions would wave them straight back through if anyone
 * reintroduced them.
 *
 * So an allowance is only valid while its collision is actually present. A
 * collision nobody allowed fails, and an allowance whose collision is gone
 * fails too — which forces the entry to be deleted in the same change that
 * removes the collision, and leaves an empty list that admits nothing.
 */
export function ruleIdCollisionFailures(params: {
  declarations: readonly RuleDeclaration[];
  allowed: readonly string[];
}): string[] {
  const present = new Set(duplicateRuleIds(params.declarations));
  const allowed = new Set(params.allowed);
  return [
    ...[...present]
      .filter((collision) => !allowed.has(collision))
      .map(
        (collision) => `two rules answer to one id: ${collision}. Allocate the next free number.`,
      ),
    ...[...allowed]
      .filter((collision) => !present.has(collision))
      .map(
        (collision) =>
          `stale allowance: "${collision}" no longer occurs, so the entry admits a collision ` +
          'nobody is fixing. Delete it from KNOWN_RULE_ID_COLLISIONS.',
      ),
  ].sort();
}

/** The layering policy modules, which is where rule ids are declared. */
export function readLayeringSources(directory: string): { path: string; source: string }[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.test.ts'))
    .map((entry) => ({
      path: `scripts/layering/${entry}`,
      source: readFileSync(path.join(directory, entry), 'utf8'),
    }));
}
