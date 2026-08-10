// The affected-check selector's own category universe, derived from its source.
//
// #1429 asks for path-category reachability "for each catalog path category". A hand-picked
// list of representative paths cannot satisfy that: it answers only for the categories someone
// remembered, and a NEW ownership rule — the exact thing that would go unnoticed — stays
// unrepresented while the gate reports green. So the universe comes from the selector itself.
//
// scripts/check-affected/model.ts names each category twice over, in two shapes:
//
//   reason('coverage', file, 'platform-src', '...')        ← 3rd argument of every reason() call
//   { check: 'swift-runner', rule: 'own:swift', ... }      ← BUILD_OWNERSHIP table entries
//
// Both are read here, so adding either kind of rule immediately widens the universe and the
// manifest fails until a representative path exercises it. That is the "something enumerates N"
// discipline the umbrella asks for, applied to the selector rather than to a second list.

import {
  calleeName,
  children,
  collect,
  literalText,
  parseProgram,
  propertyKey,
  stringValue,
  type Node,
} from './ts-ast.ts';

/** The function whose third argument names the rule that selected a check. */
const REASON_FACTORY = 'reason';
const RULE_ARGUMENT_INDEX = 2;

/**
 * The `rule:` of a build-ownership table entry, or null for any other object.
 *
 * The selector uses `rule:` for two unrelated things. `BUILD_OWNERSHIP` entries pair it with a
 * `check:`, and those are real path categories. `FailOpenReason` literals pair it with a
 * `path:` instead (`workflow-tooling`, `unknown-path`, …) — those are not categories at all:
 * failing open runs the whole check set, so there is no owning job whose triggers could
 * exclude them. Requiring a sibling `check:` separates the two by shape rather than by a
 * hand-maintained exclusion list, which is the thing this module exists to avoid.
 */
function buildOwnershipRule(node: Node): string | null {
  if (node.type !== 'ObjectExpression') return null;
  const properties = children(node);
  if (!properties.some((property) => propertyKey(property) === 'check')) return null;
  const rule = properties.find((property) => propertyKey(property) === 'rule');
  return rule ? stringValue(rule) : null;
}

/**
 * Every category id `scripts/check-affected/model.ts` can attach to a selection. Throws when it
 * finds none: an empty universe would silently mean "nothing to represent", which is the same
 * class of quiet pass this gate exists to prevent.
 */
export function selectorRuleIds(file: string, source: string): string[] {
  const program = parseProgram(file, source);
  const rules = new Set<string>();

  collect(program, (node) => {
    if (calleeName(node) === REASON_FACTORY) {
      const args = node['arguments'];
      const literal = Array.isArray(args) ? literalText(args[RULE_ARGUMENT_INDEX]) : null;
      if (literal !== null) rules.add(literal);
      return;
    }
    // The build-ownership table states its rule as a property instead of a call argument.
    const owned = buildOwnershipRule(node);
    if (owned !== null) rules.add(owned);
  });

  if (rules.size === 0) {
    throw new Error(
      `Found no selection rule ids in ${file}. The gate manifest derives the path-category ` +
        `universe from its \`${REASON_FACTORY}(check, file, rule, detail)\` calls and its ` +
        `\`rule:\` table entries; if the selector changed shape, update ` +
        `scripts/gate-manifest/selector-rules.ts to follow it.`,
    );
  }
  return [...rules].sort();
}
