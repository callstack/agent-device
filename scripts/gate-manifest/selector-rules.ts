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
  isNode,
  lineOf,
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
function buildOwnershipRule(node: Node): { rule: string | null; declared: boolean } {
  if (node.type !== 'ObjectExpression') return { rule: null, declared: false };
  const properties = children(node);
  if (!properties.some((property) => propertyKey(property) === 'check')) {
    return { rule: null, declared: false };
  }
  const rule = properties.find((property) => propertyKey(property) === 'rule');
  if (!rule) return { rule: null, declared: false };
  // `{ check, path: file, rule, detail }` — the `reason` factory forwarding its own parameter.
  // A shorthand property cannot name a category; the literal is at the call site, which this
  // reader visits separately. Declaring it "not declared" keeps it out of the fail-closed set
  // without weakening the rule for a genuinely dynamic value.
  if (rule['shorthand'] === true) return { rule: null, declared: false };
  return { rule: stringValue(rule), declared: true };
}

/**
 * Whether a `reason(...)` rule argument merely forwards a rule already read from elsewhere.
 *
 * `reason(entry.check, file, entry.rule, entry.detail)` in the build-ownership loop is the one
 * live case: the literal lives in the BUILD_OWNERSHIP table, which this reader already
 * collects, so the forwarding call adds no category. Anything else non-literal — a template
 * string, a variable, a call — could name a category this reader would never see, and must
 * fail closed.
 */
function forwardsAKnownRule(argument: unknown): boolean {
  if (!isNode(argument)) return false;
  const isMemberAccess =
    argument.type === 'MemberExpression' || argument.type === 'StaticMemberExpression';
  if (!isMemberAccess) return false;
  const property = argument['property'];
  return isNode(property) && property['name'] === 'rule';
}

/**
 * Every category id `scripts/check-affected/model.ts` can attach to a selection. Throws when it
 * finds none: an empty universe would silently mean "nothing to represent", which is the same
 * class of quiet pass this gate exists to prevent.
 */
export function selectorRuleIds(file: string, source: string): string[] {
  const program = parseProgram(file, source);
  const rules = new Set<string>();

  // Shapes this reader cannot turn into a category id. Silently skipping them would let a
  // future live category slip past the derived universe — and therefore past the
  // representative-sample and reachability checks — which is the whole hole this module
  // closes. So they fail closed, pointing at the line to fix.
  const unsupported: string[] = [];

  collect(program, (node) => {
    if (calleeName(node) === REASON_FACTORY) {
      const args = node['arguments'];
      const argument = Array.isArray(args) ? args[RULE_ARGUMENT_INDEX] : undefined;
      const literal = literalText(argument);
      if (literal !== null) {
        rules.add(literal);
        return;
      }
      if (forwardsAKnownRule(argument)) return;
      unsupported.push(
        `line ${lineOf(source, isNode(argument) ? argument : node)}: \`${REASON_FACTORY}(...)\` ` +
          `rule argument is not a string literal`,
      );
      return;
    }
    // The build-ownership table states its rule as a property instead of a call argument.
    const owned = buildOwnershipRule(node);
    if (!owned.declared) return;
    if (owned.rule !== null) {
      rules.add(owned.rule);
      return;
    }
    unsupported.push(
      `line ${lineOf(source, node)}: build-ownership \`rule:\` is not a string literal`,
    );
  });

  if (unsupported.length > 0) {
    throw new Error(
      `Cannot derive the path-category universe from ${file} — ` +
        `${unsupported.length} rule(s) are not statically readable:\n` +
        unsupported.map((entry) => `  - ${entry}`).join('\n') +
        `\nThe gate manifest needs every category id as a literal so it can check that a ` +
        `representative path exercises it. Write the rule as a string literal, or teach ` +
        `scripts/gate-manifest/selector-rules.ts the new shape.`,
    );
  }

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
