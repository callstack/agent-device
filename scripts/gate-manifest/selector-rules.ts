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
// Anything else fails closed. A category this reader cannot see would bypass the derived
// universe and therefore the representative-sample and reachability checks too, so a rule that
// is not a string literal is an error naming its line — never a silent skip. The two shapes
// that legitimately forward an already-collected rule are exempted by PROOF, not by pattern:
// see reasonFactorySpan and parameterBindings.

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

function isMemberAccess(node: Node): boolean {
  return node.type === 'MemberExpression' || node.type === 'StaticMemberExpression';
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

/** Variables initialized to an array literal containing at least one `{ check, rule }` entry. */
function ownershipTableNames(program: Node, factory: Span | null): Set<string> {
  const names = new Set<string>();
  collect(program, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const name = identifierName(node['id']);
    const init = node['init'];
    if (name === null || !isNode(init) || init.type !== 'ArrayExpression') return;
    const holdsOwnershipEntry = children(init).some((element) => {
      if (element.type !== 'ObjectExpression' || within(factory, element)) return false;
      const properties = children(element);
      return (
        properties.some((property) => propertyKey(property) === 'check') &&
        properties.some((property) => propertyKey(property) === 'rule')
      );
    });
    if (holdsOwnershipEntry) names.add(name);
  });
  return names;
}

/**
 * Array methods that yield the SAME elements. An ownership entry stays an ownership entry
 * through `.filter(...)`; it does not through `.map(transform)`, whose callback can return
 * anything, so the elements downstream are no longer table entries and their `.rule` is no
 * longer a literal this reader has collected.
 */
const VALUE_PRESERVING_METHODS = new Set([
  'filter',
  'slice',
  'reverse',
  'sort',
  'toSorted',
  'toReversed',
]);

/** Whether an expression evaluates to elements of a collected ownership table, unchanged. */
function yieldsOwnershipEntries(node: unknown, tables: ReadonlySet<string>): boolean {
  let current: unknown = node;
  for (let depth = 0; isNode(current) && depth < 32; depth++) {
    const name = identifierName(current);
    if (name !== null) return tables.has(name);
    if (current.type !== 'CallExpression') return false;
    const callee = current['callee'];
    if (!isNode(callee) || !isMemberAccess(callee)) return false;
    const method = identifierName(callee['property']);
    if (method === null || !VALUE_PRESERVING_METHODS.has(method)) return false;
    current = callee['object'];
  }
  return false;
}

/**
 * Whether a call iterates a collected ownership table — `BUILD_OWNERSHIP.filter(...).map(cb)`.
 *
 * This is what makes the forwarding exemption a proof rather than a pattern. Accepting any
 * member access named `.rule` would silently skip `reason(check, file, config.rule, …)`, whose
 * literal this reader never sees — a live category slipping past the derived universe while
 * the gate stays green. Only a binding whose values are provably unchanged table entries
 * qualifies, because only then is the literal guaranteed to have been collected already.
 */
function iteratesOwnershipTable(node: Node, tables: ReadonlySet<string>): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node['callee'];
  if (!isNode(callee) || !isMemberAccess(callee)) return false;
  return yieldsOwnershipEntries(callee['object'], tables);
}

function isFunctionLike(node: Node): boolean {
  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  );
}

/** The function arguments of a call — the `(entry) => …` in `.map((entry) => …)`. */
function callbackFunctions(node: Node): Node[] {
  const args = node['arguments'];
  if (!Array.isArray(args)) return [];
  return args.filter((argument): argument is Node => isNode(argument) && isFunctionLike(argument));
}

/** Every identifier a binding pattern introduces, including destructured ones. */
function patternNames(node: unknown, into: Set<string>): void {
  if (!isNode(node)) return;
  const name = identifierName(node);
  if (name !== null) {
    into.add(name);
    return;
  }
  for (const child of children(node)) patternNames(child, into);
}

/** Whether a node introduces `name` as a new binding of any kind. */
function declaresName(node: Node, name: string): boolean {
  const names = new Set<string>();
  if (node.type === 'VariableDeclarator') patternNames(node['id'], names);
  else if (node.type === 'CatchClause') patternNames(node['param'], names);
  else if (isFunctionLike(node)) {
    patternNames(node['id'], names);
    const params = node['params'];
    if (Array.isArray(params)) for (const parameter of params) patternNames(parameter, names);
  }
  return names.has(name);
}

/**
 * Any re-declaration of `name` inside `callback` other than the callback's own parameter.
 *
 * Resolving to the innermost FUNCTION binder is not enough on its own: a block, catch or loop
 * binding shadows the ownership parameter without being a function parameter at all, and the
 * resolver would otherwise fall back to the ownership binding and exempt a dynamic rule —
 *
 *   BUILD_OWNERSHIP.map((entry) => { const entry = config; reason(…, entry.rule, …); })
 *
 * Rather than model every scoping construct, this refuses the exemption whenever the name is
 * re-declared anywhere inside the callback. That over-refuses in principle (a re-declaration in
 * a sibling block cannot reach the call site) and fails closed, which is the right direction.
 */
function shadowsParameter(program: Node, callback: Node, name: string): boolean {
  const span = spanOf(callback);
  if (span === null) return true;
  let shadowed = false;
  collect(program, (node) => {
    if (shadowed || node === callback) return;
    if (within(span, node) && declaresName(node, name)) shadowed = true;
  });
  return shadowed;
}

/**
 * A name bound by a function's parameter list, with the source span it is visible in.
 *
 * Scope, not spelling, is what makes the forwarding exemption safe. Keying it on the NAME
 * `entry` would mean that once the real `BUILD_OWNERSHIP` loop contributes that name, any
 * unrelated — or shadowing — `entry.rule` elsewhere in the file is exempt too, and a live
 * category slips past the derived universe exactly as before. Recording the binding's span
 * lets a `.rule` access be matched to the innermost binder that actually covers it.
 */
type ParameterBinding = { name: string; span: Span; iteratesOwnership: boolean };

function parameterBindings(program: Node, tables: ReadonlySet<string>): ParameterBinding[] {
  const ownershipCallbacks = new Set<Node>();
  collect(program, (node) => {
    if (!iteratesOwnershipTable(node, tables)) return;
    for (const callback of callbackFunctions(node)) ownershipCallbacks.add(callback);
  });

  const bindings: ParameterBinding[] = [];
  collect(program, (node) => {
    const span = isFunctionLike(node) ? spanOf(node) : null;
    const params = node['params'];
    if (span === null || !Array.isArray(params)) return;
    const owns = ownershipCallbacks.has(node);
    for (const parameter of params) {
      const name = identifierName(parameter);
      if (name === null) continue;
      const iteratesOwnership = owns && !shadowsParameter(program, node, name);
      bindings.push({ name, span, iteratesOwnership });
    }
  });
  return bindings;
}

/**
 * `entry.rule` where `entry` resolves — at this exact site — to the parameter of a callback
 * iterating a collected ownership table. The innermost covering binder wins, so a shadowing
 * `entry` from an unrelated loop is rejected even inside the real one.
 */
function forwardsACollectedRule(argument: unknown, bindings: readonly ParameterBinding[]): boolean {
  if (!isNode(argument) || !isMemberAccess(argument)) return false;
  if (identifierName(argument['property']) !== 'rule') return false;
  const object = identifierName(argument['object']);
  const site = spanOf(argument);
  if (object === null || site === null) return false;
  const covering = bindings.filter(
    (binding) =>
      binding.name === object && binding.span.start <= site.start && site.end <= binding.span.end,
  );
  // Latest start = innermost enclosing function that binds this name.
  const innermost = covering.reduce<ParameterBinding | null>(
    (best, binding) => (best === null || binding.span.start > best.span.start ? binding : best),
    null,
  );
  return innermost?.iteratesOwnership === true;
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
 * Every category id `scripts/check-affected/model.ts` can attach to a selection. Throws when a
 * rule is not statically readable, and when it finds none at all — an empty universe would
 * silently mean "nothing to represent", the same class of quiet pass this gate exists to stop.
 */
export function selectorRuleIds(file: string, source: string): string[] {
  const program = parseProgram(file, source);
  const factory = reasonFactorySpan(program);
  const bindings = parameterBindings(program, ownershipTableNames(program, factory));

  const rules = new Set<string>();
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
      if (forwardsACollectedRule(argument, bindings)) return;
      unsupported.push(
        `line ${lineOf(source, isNode(argument) ? argument : node)}: \`${REASON_FACTORY}(...)\` ` +
          `rule argument is not a string literal`,
      );
      return;
    }
    // The build-ownership table states its rule as a property instead of a call argument.
    if (within(factory, node)) return;
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
