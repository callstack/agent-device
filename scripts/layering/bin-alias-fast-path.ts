// R12 bin-alias-fast-path.
//
// `bin.ts`'s `--help` fast path resolves a command alias (`tap`, `launch`, …) to its canonical
// command before looking up static help text. #1618-adjacent: bin.ts once carried its own
// hand-written two-entry table (`long-press`, `metrics`) instead of calling the real alias
// registry, `commands/cli-command-aliases.ts` (five entries). The table silently fell out of
// sync — `tap`, `launch`, `relaunch` missed the fast path entirely and paid a full CLI bootstrap
// just to print static help text — and nothing failed, because bin.ts's own top-level dispatch
// runs unconditionally on import (see the module comment on `check.ts`'s R7 for the same
// "cannot safely unit-import this file" constraint) and is deliberately excluded from coverage
// (`vitest.config.ts`), so no unit test can call into it directly.
//
// Three structural facts, read from bin.ts's source text rather than by importing and running
// it, close the gap without needing to import it:
//   1. bin.ts holds a VALUE import of `normalizeCliCommandAlias` from the registry — so it is
//      wired to delegate.
//   2. bin.ts never itself contains one of the registry's OWN alias tokens as a string literal —
//      so it cannot be re-declaring a parallel mapping instead of actually calling the import.
//   3. EVERY call to `buildCommandUsageText` in bin.ts receives `<resolver>(<helpTarget>)` — the
//      LOCAL binding fact 1 imported, applied to the binding the fast path's own
//      `resolveSimpleHelpTarget(...)` produced. This is the actual composition the fast path
//      needs (`buildCommandUsageText(normalizeCliCommandAlias(helpTarget))`), not merely the
//      import's presence. Facts 1 and 2 alone still pass if bin.ts imports the resolver and never
//      calls it, or calls it on something unrelated (`void normalizeCliCommandAlias`) while
//      `buildCommandUsageText(helpTarget)` runs raw — a real gap a maintainer review caught
//      (the guard's own P2 follow-up).
//
// Fact 3 is deliberately UNIVERSAL and VALUE-BOUND, not existential, which is the second P2 from
// the same review. An "is there any `buildCommandUsageText(resolver(...))` somewhere" phrasing is
// satisfied by a decoy that never runs on the help target:
//
//     void buildCommandUsageText(normalizeCliCommandAlias('press'));   // decoy, satisfies ∃
//     const commandHelp = buildCommandUsageText(helpTarget);           // what actually ships
//
// Requiring every usage-text call to receive the resolver applied to the help-target binding
// rejects both lines: the decoy resolves a literal rather than the fast path's own value, and the
// shipped call is raw. The help-target binding is discovered from bin.ts's source (the variable
// initialized by `resolveSimpleHelpTarget(...)`) rather than hard-coded, so renaming the local
// does not silently disarm the guard — it re-points it.
//
// Fact 3 binds by the import's LOCAL name, following any `as` alias, so
// `import { normalizeCliCommandAlias as resolveAlias }` still passes. Because that is a
// name-based claim about binding identity, fact 3 additionally requires that no local
// declaration in bin.ts SHADOWS either name: a local `const normalizeCliCommandAlias = (c) => c`
// would otherwise let the composition read correctly while calling something else entirely, and
// a second `helpTarget` declaration would let the resolver run on an unrelated value.
//
// All three were false on the pre-fix bin.ts (no import; both 'long-press' and 'metrics' present
// as literals; no composition to find), so the set is a real regression pin, not just a
// description of intent.
//
// AST-based (`oxc-parser`, the standing precedent in this directory — session-state.ts,
// facade-exports.ts, zero-dep-jobs.ts), not a line scan: a line scan reading raw text for
// "'tap'" would mistake this very comment, or a fixture string in a test file, for the real
// thing — precisely the false-positive failure mode that turned this directory to
// `parseSync(...).module`/`.program` in the first place.

import { parseSync } from 'oxc-parser';

export const BIN_FILE = 'src/bin.ts';
export const ALIAS_REGISTRY_FILE = 'src/commands/cli-command-aliases.ts';
// The specifier bin.ts must use to reach the registry — relative to BIN_FILE's own directory
// (src/), not to the repo root, since that is how bin.ts's own import statement writes it.
const ALIAS_REGISTRY_SPECIFIER = './commands/cli-command-aliases.ts';
const ALIAS_RESOLVER_EXPORT = 'normalizeCliCommandAlias';

/** Depth-first walk over an oxc-parser AST subtree (or `.module` entry list). */
function visit(node: unknown, onNode: (record: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, onNode);
    return;
  }
  const record = node as Record<string, unknown>;
  onNode(record);
  for (const key of Object.keys(record)) visit(record[key], onNode);
}

/**
 * The alias tokens the registry declares — `CLI_COMMAND_ALIASES`'s `alias:` property values,
 * read out of the registry's own source text rather than imported and executed. Every other
 * gate in this directory treats its target as data to parse, not a module to run (session-state
 * .ts reads `daemon/types.ts` the same way); staying consistent means R12 needs no `pnpm build`
 * and cannot be fooled by import side effects. `CLI_COMMAND_ALIASES` itself is deliberately
 * unexported (a façade names only what it means to share) — this reads its literal values
 * directly out of the array-literal declaration instead, so a future sixth alias is picked up
 * automatically and this list never needs hand-maintaining in a second place.
 */
export function registryAliasTokens(registrySource: string): string[] {
  const parsed = parseSync(ALIAS_REGISTRY_FILE, registrySource);
  const tokens = new Set<string>();
  visit(parsed.program, (record) => {
    if (record['type'] !== 'Property') return;
    const key = record['key'] as Record<string, unknown> | undefined;
    if (key?.['type'] !== 'Identifier' || key['name'] !== 'alias') return;
    const value = record['value'] as Record<string, unknown> | undefined;
    if (value?.['type'] === 'Literal' && typeof value['value'] === 'string') {
      tokens.add(value['value'] as string);
    }
  });
  return [...tokens].sort();
}

/**
 * The LOCAL binding name `binSource` imports `normalizeCliCommandAlias` as — following any `as`
 * alias — for a VALUE (not type-only) import from the alias registry, or `null` if there is no
 * such import. Reads `oxc-parser`'s own resolved import-entry table (`module.staticImports`),
 * the same source `zero-dep-jobs.ts`'s `moduleSpecifiers` uses — not a regex, so
 * `import type { normalizeCliCommandAlias as x }` (erased at compile time, no runtime delegation
 * at all) cannot pass as a real import the way a line match on the specifier text would.
 *
 * Reporting the LOCAL name (not just a boolean) is what lets `usageTextDelegationFailure` below
 * bind by the name bin.ts actually calls, so a renamed import (`... as resolveAlias`) still
 * verifies, while a same-named unrelated local cannot be mistaken for it (that one is enforced,
 * not assumed — see the shadow check there).
 */
export function aliasResolverLocalName(binSource: string): string | null {
  const parsed = parseSync(BIN_FILE, binSource);
  for (const entry of parsed.module.staticImports) {
    if (entry.moduleRequest.value !== ALIAS_REGISTRY_SPECIFIER) continue;
    for (const specifier of entry.entries) {
      if (
        !specifier.isType &&
        specifier.importName.kind === 'Name' &&
        specifier.importName.name === ALIAS_RESOLVER_EXPORT
      ) {
        return specifier.localName.value;
      }
    }
  }
  return null;
}

/** Whether `binSource` holds a VALUE import of `normalizeCliCommandAlias` from the registry. */
export function importsAliasResolver(binSource: string): boolean {
  return aliasResolverLocalName(binSource) !== null;
}

const USAGE_TEXT_CALLEE = 'buildCommandUsageText';
const HELP_TARGET_PRODUCER = 'resolveSimpleHelpTarget';

function isCallTo(node: unknown, calleeName: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  if (record['type'] !== 'CallExpression') return false;
  const callee = record['callee'] as Record<string, unknown> | undefined;
  return callee?.['type'] === 'Identifier' && callee['name'] === calleeName;
}

function isIdentifierNamed(node: unknown, name: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  return record['type'] === 'Identifier' && record['name'] === name;
}

/** A short, quotable rendering of an argument expression, for the violation message. */
function describeArgument(node: unknown): string {
  if (node === null || typeof node !== 'object') return String(node);
  const record = node as Record<string, unknown>;
  if (record['type'] === 'Identifier') return String(record['name']);
  if (record['type'] === 'Literal') return JSON.stringify(record['value']);
  if (record['type'] === 'CallExpression') {
    const callee = record['callee'] as Record<string, unknown> | undefined;
    const calleeName = callee?.['type'] === 'Identifier' ? String(callee['name']) : '<expr>';
    const args = Array.isArray(record['arguments']) ? record['arguments'] : [];
    return `${calleeName}(${args.map(describeArgument).join(', ')})`;
  }
  return `<${String(record['type'])}>`;
}

/**
 * The LOCAL name of the fast path's help-target binding — the variable initialized by
 * `resolveSimpleHelpTarget(...)` — or `null` if bin.ts no longer produces one that way.
 *
 * Read from the source rather than hard-coded so that renaming the local re-points the guard
 * instead of disarming it, and so `helpTarget` never has to be maintained as a magic string in
 * two places.
 */
export function helpTargetBindingName(binSource: string): string | null {
  const parsed = parseSync(BIN_FILE, binSource);
  let name: string | null = null;
  visit(parsed.program, (record) => {
    if (name !== null || record['type'] !== 'VariableDeclarator') return;
    if (!isCallTo(record['init'], HELP_TARGET_PRODUCER)) return;
    const id = record['id'] as Record<string, unknown> | undefined;
    if (id?.['type'] === 'Identifier') name = String(id['name']);
  });
  return name;
}

/**
 * Every VALUE binding `binSource` declares locally under `name` — variable declarators, function
 * and class declarations, function parameters, and catch clauses.
 *
 * This is what makes fact 3's binding-identity claim real rather than nominal: the composition
 * `buildCommandUsageText(normalizeCliCommandAlias(helpTarget))` reads as delegation whether the
 * callee is the import or a local shadow that happens to share its name, and only a declaration
 * scan can tell those apart. Over-collection is the safe direction here — a false positive on
 * these two specific names fails the gate loudly rather than passing a shadowed call silently —
 * so patterns are walked whole, with type annotations skipped (a type named `helpTarget` binds
 * nothing at runtime and must not count as a shadow).
 */
export function countLocalBindings(binSource: string, name: string): number {
  const parsed = parseSync(BIN_FILE, binSource);
  let count = 0;
  const scanPattern = (node: unknown): void => {
    visitSkippingTypes(node, (record) => {
      if (isIdentifierNamed(record, name)) count += 1;
    });
  };
  visit(parsed.program, (record) => {
    switch (record['type']) {
      case 'VariableDeclarator':
        scanPattern(record['id']);
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (isIdentifierNamed(record['id'], name)) count += 1;
        scanPattern(record['params']);
        return;
      case 'CatchClause':
        scanPattern(record['param']);
        return;
      default:
    }
  });
  return count;
}

/** `visit`, minus type-position subtrees — type names bind nothing at runtime. */
function visitSkippingTypes(
  node: unknown,
  onNode: (record: Record<string, unknown>) => void,
): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitSkippingTypes(child, onNode);
    return;
  }
  const record = node as Record<string, unknown>;
  onNode(record);
  for (const key of Object.keys(record)) {
    if (key === 'typeAnnotation' || key === 'returnType' || key === 'typeParameters') continue;
    visitSkippingTypes(record[key], onNode);
  }
}

/**
 * Why `binSource` fails fact 3, or `null` if it holds.
 *
 * Fact 3 is universal and value-bound: EVERY `buildCommandUsageText(...)` call in bin.ts must
 * receive `resolverLocalName(<helpTarget>)`, where `<helpTarget>` is the binding
 * `resolveSimpleHelpTarget(...)` produced. The existential phrasing this replaces ("some call
 * somewhere wraps the resolver") is satisfied by a decoy that resolves an unrelated value while
 * the shipped call runs raw — see the module comment for that exact fixture.
 *
 * Returning the reason rather than a boolean lets the gate say which of the several distinct
 * ways to fail actually happened; a bare `false` sent a maintainer back to re-derive it.
 */
export function usageTextDelegationFailure(
  binSource: string,
  resolverLocalName: string,
): string | null {
  if (countLocalBindings(binSource, resolverLocalName) > 0) {
    return (
      `declares a local binding named ${resolverLocalName}, shadowing the imported resolver — ` +
      `a call to ${resolverLocalName}(...) then proves nothing about delegating to ` +
      `${ALIAS_REGISTRY_FILE}. Remove the shadow (or import the resolver under a different name).`
    );
  }

  const helpTarget = helpTargetBindingName(binSource);
  if (helpTarget === null) {
    return (
      `has no variable initialized by ${HELP_TARGET_PRODUCER}(...), so the --help fast path's ` +
      'help-target binding cannot be located and its delegation cannot be checked. Keep the ' +
      'fast path resolving its target through that helper, or re-point this rule at its ' +
      'replacement.'
    );
  }
  if (countLocalBindings(binSource, helpTarget) > 1) {
    return (
      `declares ${helpTarget} more than once, so "${USAGE_TEXT_CALLEE}(${resolverLocalName}(` +
      `${helpTarget}))" no longer names one value — the resolver could be running on an ` +
      'unrelated binding that shares the name.'
    );
  }

  const parsed = parseSync(BIN_FILE, binSource);
  const calls: Record<string, unknown>[] = [];
  visit(parsed.program, (record) => {
    if (isCallTo(record, USAGE_TEXT_CALLEE)) calls.push(record);
  });

  if (calls.length === 0) {
    return (
      `never calls ${USAGE_TEXT_CALLEE} — the --help fast path that alias resolution exists to ` +
      'serve is gone, so this rule is checking nothing. Restore the fast path or retire R12.'
    );
  }

  for (const call of calls) {
    const args = Array.isArray(call['arguments']) ? call['arguments'] : [];
    const first = args[0];
    const wraps = isCallTo(first, resolverLocalName);
    const resolverArgs =
      wraps && Array.isArray((first as Record<string, unknown>)['arguments'])
        ? ((first as Record<string, unknown>)['arguments'] as unknown[])
        : [];
    if (wraps && isIdentifierNamed(resolverArgs[0], helpTarget)) continue;
    return (
      `calls ${USAGE_TEXT_CALLEE}(${describeArgument(first)}) — every ${USAGE_TEXT_CALLEE} call ` +
      `must receive ${resolverLocalName}(${helpTarget}), the imported resolver applied to the ` +
      'fast path’s own help target. A call that resolves something else (or nothing) leaves ' +
      'the shipped path un-delegated while looking wired.'
    );
  }
  return null;
}

/**
 * Which of `tokens` appear as a string-literal VALUE anywhere in `binSource` — not a substring
 * match on the raw text, so a token that only shows up inside an unrelated identifier or this
 * module's own doc comment does not count.
 */
export function localAliasLiterals(binSource: string, tokens: readonly string[]): string[] {
  const wanted = new Set(tokens);
  const parsed = parseSync(BIN_FILE, binSource);
  const found = new Set<string>();
  visit(parsed.program, (record) => {
    if (record['type'] !== 'Literal') return;
    const value = record['value'];
    if (typeof value === 'string' && wanted.has(value)) found.add(value);
  });
  return [...found].sort();
}
