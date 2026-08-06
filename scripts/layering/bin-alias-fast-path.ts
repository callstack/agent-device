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
//   3. bin.ts's call to `buildCommandUsageText` receives, as an argument, a call to the LOCAL
//      binding fact 1 imported — the actual composition the fast path needs
//      (`buildCommandUsageText(normalizeCliCommandAlias(helpTarget))`), not merely the import's
//      presence. Facts 1 and 2 alone still pass if bin.ts imports the resolver and never calls
//      it, or calls it on something unrelated (`void normalizeCliCommandAlias`) while
//      `buildCommandUsageText(helpTarget)` runs raw — a real gap a maintainer review caught
//      (the guard's own P2 follow-up). Fact 3 binds by the import's LOCAL name, following any
//      `as` alias, so `import { normalizeCliCommandAlias as resolveAlias }` still passes and an
//      unrelated same-named local does not.
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
 * Reporting the LOCAL name (not just a boolean) is what lets `usageTextCallsResolver` below bind
 * by the name bin.ts actually calls, so a renamed import (`... as resolveAlias`) still verifies,
 * while a same-named unrelated local elsewhere in the file cannot be mistaken for it.
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

function isCallTo(node: unknown, calleeName: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as Record<string, unknown>;
  if (record['type'] !== 'CallExpression') return false;
  const callee = record['callee'] as Record<string, unknown> | undefined;
  return callee?.['type'] === 'Identifier' && callee['name'] === calleeName;
}

/**
 * Whether `binSource` calls `buildCommandUsageText` with an argument that is ITSELF a call to
 * `resolverLocalName` — the composition the `--help` fast path actually needs
 * (`buildCommandUsageText(normalizeCliCommandAlias(helpTarget))`), not merely both names
 * appearing somewhere in the file. Import presence and literal absence (facts 1 and 2 above)
 * both still hold if bin.ts imports the resolver and never calls it, or calls it on something
 * unrelated while `buildCommandUsageText(helpTarget)` runs raw — this is the fact that closes
 * that gap: it inspects the actual argument expression at the actual call site, not just whether
 * both identifiers occur in the source.
 */
export function usageTextCallsResolver(binSource: string, resolverLocalName: string): boolean {
  const parsed = parseSync(BIN_FILE, binSource);
  let found = false;
  visit(parsed.program, (record) => {
    if (found || !isCallTo(record, 'buildCommandUsageText')) return;
    const args = record['arguments'];
    if (!Array.isArray(args)) return;
    found = args.some((arg) => isCallTo(arg, resolverLocalName));
  });
  return found;
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
