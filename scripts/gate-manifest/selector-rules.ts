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
//
// This reader collects STRING LITERALS and nothing else. Anything else is an error naming its
// line, never a silent skip: a category this reader cannot see would bypass the derived universe
// and the representative-sample and reachability checks with it.
//
// Earlier revisions tried to PROVE that one non-literal shape was safe — `entry.rule`, forwarded
// out of a loop over the ownership table — by tracing the binding back to the table. That did
// not work, and the way it failed is the reason it is gone. Six rounds each closed the reported
// hole and left the same class open one level down: match by pattern, then by name, then by
// lexical scope, then by binder kind, then a total "every use is a property read" proof — which
// still admitted a mutating upstream `.filter()` callback and a mutating `entry.method()` call.
// Closing those two requires treating any member call on the binding as unsafe, and the live
// call site is `BUILD_OWNERSHIP.filter((entry) => entry.owns(file)).map(...)`: `entry.owns(file)`
// is itself a member call that could mutate the entry. A proof strict enough to be sound rejects
// the one call it existed to admit, so there is no proof left to keep.
//
// The forward is therefore DECLARED, not detected — FORWARDED_SELECTOR_RULES in waivers.ts,
// keyed on the exact source text of the call, and policed like every other waiver: a waiver that
// matches no call is inert and fails, and a waiver that matches two calls fails too, so one
// entry can never quietly come to stand for a second forward somebody added later.

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

type Span = { start: number; end: number };

function spanOf(node: Node): Span | null {
  const { start, end } = node as { start?: unknown; end?: unknown };
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null;
}

function within(span: Span | null, node: Node): boolean {
  const inner = spanOf(node);
  return span !== null && inner !== null && inner.start >= span.start && inner.end <= span.end;
}

function identifierName(node: unknown): string | null {
  return isNode(node) && node.type === 'Identifier' && typeof node['name'] === 'string'
    ? node['name']
    : null;
}

/**
 * A call's own source text, whitespace collapsed.
 *
 * This is what a FORWARDED_SELECTOR_RULES waiver is keyed on. Text is a blunt key, and that is
 * the point: it cannot drift into meaning something broader than what was reviewed. Reformatting
 * or rewrapping the call keeps the waiver (whitespace is normalized); changing an argument, a
 * name, or the shape does not, and the gate says so.
 */
function callText(source: string, node: Node): string {
  const span = spanOf(node);
  return span === null ? '' : source.slice(span.start, span.end).replace(/\s+/g, ' ').trim();
}

/**
 * The body of the `reason(check, file, rule, detail)` factory itself.
 *
 * Its `return { check, path: file, rule, detail }` pairs a `check` with a `rule`, so it looks
 * exactly like a build-ownership entry — but it declares no category: it forwards its own
 * parameters, and the literal lives at each call site, which this reader visits separately.
 * Excluding it by the factory's source span is provable; excluding "any shorthand `rule`"
 * would also swallow a real table entry someone wrote with shorthand variables.
 */
function reasonFactorySpan(program: Node): Span | null {
  let span: Span | null = null;
  collect(program, (node) => {
    if (span !== null) return;
    const isFactory =
      (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') &&
      identifierName(node['id']) === REASON_FACTORY;
    if (isFactory) span = spanOf(node);
  });
  return span;
}

/** The `rule:` of a build-ownership entry, or `declared: false` for any other object. */
function buildOwnershipRule(node: Node): { rule: string | null; declared: boolean } {
  if (node.type !== 'ObjectExpression') return { rule: null, declared: false };
  const properties = children(node);
  // A `rule:` paired with `path:` rather than `check:` is a FailOpenReason literal
  // (`workflow-tooling`, `unknown-path`, …), not a category: failing open runs the whole check
  // set, so no owning job's triggers could exclude it. Separating the two by shape avoids a
  // hand-maintained exclusion list, which is the thing this module exists to avoid.
  if (!properties.some((property) => propertyKey(property) === 'check')) {
    return { rule: null, declared: false };
  }
  const rule = properties.find((property) => propertyKey(property) === 'rule');
  if (!rule) return { rule: null, declared: false };
  return { rule: stringValue(rule), declared: true };
}

/** What one node contributes: a category, a waiver hit, a problem, or nothing. */
type Reading =
  | { kind: 'rule'; rule: string }
  | { kind: 'waived'; call: string }
  | { kind: 'unsupported'; problem: string }
  | null;

function readReasonCall(source: string, node: Node, waivedCalls: ReadonlySet<string>): Reading {
  const args = node['arguments'];
  const argument = Array.isArray(args) ? args[RULE_ARGUMENT_INDEX] : undefined;
  const literal = literalText(argument);
  if (literal !== null) return { kind: 'rule', rule: literal };
  const call = callText(source, node);
  if (waivedCalls.has(call)) return { kind: 'waived', call };
  return {
    kind: 'unsupported',
    problem:
      `line ${lineOf(source, isNode(argument) ? argument : node)}: \`${call}\` — ` +
      `rule argument is not a string literal`,
  };
}

function readOwnershipEntry(source: string, node: Node): Reading {
  const owned = buildOwnershipRule(node);
  if (!owned.declared) return null;
  if (owned.rule !== null) return { kind: 'rule', rule: owned.rule };
  return {
    kind: 'unsupported',
    problem: `line ${lineOf(source, node)}: build-ownership \`rule:\` is not a string literal`,
  };
}

function readNode(
  source: string,
  node: Node,
  factory: Span | null,
  waivedCalls: ReadonlySet<string>,
): Reading {
  if (calleeName(node) === REASON_FACTORY) return readReasonCall(source, node, waivedCalls);
  // The build-ownership table states its rule as a property instead of a call argument.
  return within(factory, node) ? null : readOwnershipEntry(source, node);
}

export type SelectorRules = {
  /** Every category id the selector can attach to a selection, sorted. */
  readonly rules: readonly string[];
  /** Waived call text → how many `reason(...)` calls in this file it matched. */
  readonly waiverMatches: ReadonlyMap<string, number>;
};

/**
 * Reads every category id `scripts/check-affected/model.ts` can attach to a selection.
 *
 * Throws when a rule is not a statically readable literal and no waiver in `waived` names that
 * exact call, and when it finds no rules at all — an empty universe would silently mean "nothing
 * to represent", the same class of quiet pass this gate exists to stop.
 */
export function readSelectorRules(
  file: string,
  source: string,
  waived: readonly string[] = [],
): SelectorRules {
  const program = parseProgram(file, source);
  const factory = reasonFactorySpan(program);
  const waivedCalls = new Set(waived);

  const rules = new Set<string>();
  const waiverMatches = new Map<string, number>();
  const unsupported: string[] = [];

  collect(program, (node) => {
    const reading = readNode(source, node, factory, waivedCalls);
    if (reading === null) return;
    if (reading.kind === 'rule') rules.add(reading.rule);
    else if (reading.kind === 'waived') {
      waiverMatches.set(reading.call, (waiverMatches.get(reading.call) ?? 0) + 1);
    } else unsupported.push(reading.problem);
  });

  if (unsupported.length > 0) {
    throw new Error(
      `Cannot derive the path-category universe from ${file} — ` +
        `${unsupported.length} rule(s) are not statically readable:\n` +
        unsupported.map((entry) => `  - ${entry}`).join('\n') +
        `\nThe gate manifest needs every category id as a literal so it can check that a ` +
        `representative path exercises it. Write the rule as a string literal, or — if the call ` +
        `only re-states rules the ownership table already declares — add its exact text to ` +
        `FORWARDED_SELECTOR_RULES in scripts/gate-manifest/waivers.ts with a reason.`,
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
  return { rules: [...rules].sort(), waiverMatches };
}
