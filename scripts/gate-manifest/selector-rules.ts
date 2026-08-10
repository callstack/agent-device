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
// the one call it existed to admit, so there is no proof to keep.
//
// The forward is therefore DECLARED, not detected — FORWARDED_SELECTOR_RULES in waivers.ts.
//
// What a waiver is keyed on matters as much as that it exists. Keying it on the `reason(...)`
// call alone is not enough: the claim "this rule is already in the universe" is made true by the
// CHAIN around the call, not by the call, so an entry keyed on the call survives having
// `BUILD_OWNERSHIP.filter((entry) => entry.owns(file))` swapped for a mutating callback beneath
// it. The key is therefore the whole enclosing STATEMENT — chain, callbacks and all — plus the
// file and the nearest enclosing named function, so mutating the chain or relocating the
// statement makes the waiver inert. Blunt on purpose: any edit to the reviewed code re-opens the
// review. check.ts fails the gate when an entry matches no statement (inert) or more than one
// (one reviewed claim standing for code nobody looked at).

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

/** Reported as the enclosing function when a forward sits at module scope. */
const TOP_LEVEL = '(top level)';

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

/** A node's own source text with whitespace runs collapsed, so reformatting is not a change. */
function normalize(source: string, node: Node): string {
  const span = spanOf(node);
  return span === null ? '' : source.slice(span.start, span.end).replace(/\s+/g, ' ').trim();
}

/** The tightest node satisfying `matches` whose span encloses `target`. */
function smallestContaining(
  program: Node,
  target: Span,
  matches: (node: Node) => boolean,
): Node | null {
  const candidates: { width: number; node: Node }[] = [];
  collect(program, (node) => {
    if (!matches(node)) return;
    const span = spanOf(node);
    if (span === null || span.start > target.start || span.end < target.end) return;
    candidates.push({ width: span.end - span.start, node });
  });
  candidates.sort((left, right) => left.width - right.width);
  return candidates[0]?.node ?? null;
}

function isStatement(node: Node): boolean {
  return (
    typeof node.type === 'string' &&
    (node.type.endsWith('Statement') || node.type === 'VariableDeclaration')
  );
}

function encloses(outer: Span | null, inner: Span): boolean {
  return outer !== null && outer.start <= inner.start && outer.end >= inner.end;
}

/**
 * The WIDEST statement that contains `target` without escaping `scope` — the scope's own body
 * block excluded, since that is the whole function rather than one statement in it.
 *
 * Widest, not tightest, and that matters. The tightest statement around a forward written as
 * `.map((entry) => { return reason(…); })` is the bare `return`, which says nothing about the
 * chain that produced `entry` — fingerprint that and the chain underneath it stays swappable,
 * which is the hole this whole key exists to close. Climbing to the outermost statement inside
 * the enclosing named function always captures the chain and its callbacks, and stops there
 * rather than swallowing unrelated code around it.
 */
function widestStatementIn(program: Node, target: Span, scope: Node): Node | null {
  const scopeSpan = spanOf(scope);
  const body = scope['body'];
  const bodySpan = isNode(body) ? spanOf(body) : null;
  const candidates: { width: number; node: Node }[] = [];
  collect(program, (node) => {
    const span = spanOf(node);
    if (span === null || !isStatement(node)) return;
    if (!encloses(span, target) || !encloses(scopeSpan, span)) return;
    if (bodySpan !== null && span.start === bodySpan.start && span.end === bodySpan.end) return;
    candidates.push({ width: span.end - span.start, node });
  });
  candidates.sort((left, right) => right.width - left.width);
  return candidates[0]?.node ?? null;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function isFunctionLike(node: unknown): node is Node {
  return isNode(node) && FUNCTION_TYPES.has(node.type ?? '');
}

/** The name a declarator, property or method binds a function value to. */
function boundFunction(node: Node): { fn: Node; name: string } | null {
  const value = node['init'] ?? node['value'];
  if (!isFunctionLike(value)) return null;
  const name = identifierName(node['id']) ?? identifierName(node['key']) ?? propertyKey(node);
  return name === null ? null : { fn: value, name };
}

/**
 * Every function value in the file that has a name.
 *
 * The callback a forward actually sits in is anonymous — `.map((entry) => …)` — so the useful
 * identity is the nearest *named* enclosing function. Both spellings count: a declaration's own
 * `id`, and a function assigned to a name (`const buildOwnership = (…) => …`, which is how the
 * live selector writes its ownership rules).
 */
function functionNames(program: Node): Map<Node, string> {
  const names = new Map<Node, string>();
  collect(program, (node) => {
    const own = identifierName(node['id']);
    if (isFunctionLike(node) && own !== null) names.set(node, own);
    const bound = boundFunction(node);
    if (bound !== null) names.set(bound.fn, bound.name);
  });
  return names;
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

/**
 * What a FORWARDED_SELECTOR_RULES waiver names: one forwarding statement, located.
 *
 * All three parts are load-bearing. `statement` carries the chain that makes the claim true, so
 * mutating an upstream callback invalidates the waiver even when the inner `reason(...)` call is
 * untouched. `enclosing` and `file` locate it, so the identical statement pasted somewhere else
 * is a different, unreviewed forward.
 */
export type ForwardedRuleKey = {
  readonly file: string;
  readonly enclosing: string;
  readonly statement: string;
};

function sameKey(left: ForwardedRuleKey, right: ForwardedRuleKey): boolean {
  return (
    left.file === right.file &&
    left.enclosing === right.enclosing &&
    left.statement === right.statement
  );
}

type Reader = {
  readonly file: string;
  readonly source: string;
  readonly program: Node;
  readonly factory: Span | null;
  readonly names: ReadonlyMap<Node, string>;
  readonly waived: readonly ForwardedRuleKey[];
};

function fingerprintOf(reader: Reader, call: Node): ForwardedRuleKey {
  const span = spanOf(call);
  if (span === null) return { file: reader.file, enclosing: TOP_LEVEL, statement: '' };
  const holder = smallestContaining(reader.program, span, (node) => reader.names.has(node));
  const statement = widestStatementIn(reader.program, span, holder ?? reader.program);
  return {
    file: reader.file,
    enclosing: (holder === null ? undefined : reader.names.get(holder)) ?? TOP_LEVEL,
    statement: normalize(reader.source, statement ?? call),
  };
}

/** A failure a reader can act on: what is wrong, where, and the exact waiver that would cover it. */
function describe(reader: Reader, call: Node, argument: unknown, key: ForwardedRuleKey): string {
  const line = lineOf(reader.source, isNode(argument) ? argument : call);
  return [
    `line ${line}: rule argument is not a string literal — \`${normalize(reader.source, call)}\``,
    `    file:      ${key.file}`,
    `    enclosing: ${key.enclosing}`,
    `    statement: ${key.statement}`,
  ].join('\n');
}

/** What one node contributes: a category, a waiver hit, a problem, or nothing. */
type Reading =
  | { kind: 'rule'; rule: string }
  | { kind: 'waived'; index: number }
  | { kind: 'unsupported'; problem: string }
  | null;

function readReasonCall(reader: Reader, node: Node): Reading {
  const args = node['arguments'];
  const argument = Array.isArray(args) ? args[RULE_ARGUMENT_INDEX] : undefined;
  const literal = literalText(argument);
  if (literal !== null) return { kind: 'rule', rule: literal };
  const key = fingerprintOf(reader, node);
  const index = reader.waived.findIndex((candidate) => sameKey(candidate, key));
  if (index >= 0) return { kind: 'waived', index };
  return { kind: 'unsupported', problem: describe(reader, node, argument, key) };
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

function readNode(reader: Reader, node: Node): Reading {
  if (calleeName(node) === REASON_FACTORY) return readReasonCall(reader, node);
  // The build-ownership table states its rule as a property instead of a call argument.
  return within(reader.factory, node) ? null : readOwnershipEntry(reader.source, node);
}

export type SelectorRules = {
  /** Every category id the selector can attach to a selection, sorted. */
  readonly rules: readonly string[];
  /** Parallel to the `waived` argument: how many forwarding statements each entry matched. */
  readonly waiverMatches: readonly number[];
};

/**
 * Reads every category id `scripts/check-affected/model.ts` can attach to a selection.
 *
 * Throws when a rule is not a statically readable literal and no waiver in `waived` fingerprints
 * that exact statement, and when it finds no rules at all — an empty universe would silently mean
 * "nothing to represent", the same class of quiet pass this gate exists to stop.
 */
export function readSelectorRules(
  file: string,
  source: string,
  waived: readonly ForwardedRuleKey[] = [],
): SelectorRules {
  const program = parseProgram(file, source);
  const reader: Reader = {
    file,
    source,
    program,
    factory: reasonFactorySpan(program),
    names: functionNames(program),
    waived,
  };

  const rules = new Set<string>();
  const waiverMatches = waived.map(() => 0);
  const unsupported: string[] = [];

  collect(program, (node) => {
    const reading = readNode(reader, node);
    if (reading === null) return;
    if (reading.kind === 'rule') rules.add(reading.rule);
    else if (reading.kind === 'waived') {
      waiverMatches[reading.index] = (waiverMatches[reading.index] ?? 0) + 1;
    } else unsupported.push(reading.problem);
  });

  if (unsupported.length > 0) {
    throw new Error(
      `Cannot derive the path-category universe from ${file} — ` +
        `${unsupported.length} rule(s) are not statically readable:\n` +
        unsupported.map((entry) => `  - ${entry}`).join('\n') +
        `\nThe gate manifest needs every category id as a literal so it can check that a ` +
        `representative path exercises it. Write the rule as a string literal, or — if the ` +
        `statement only re-states rules the ownership table already declares — add a ` +
        `FORWARDED_SELECTOR_RULES entry to scripts/gate-manifest/waivers.ts with a reason and ` +
        `the file/enclosing/statement above copied verbatim.`,
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
