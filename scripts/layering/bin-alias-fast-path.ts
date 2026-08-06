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
// Two structural facts, read from bin.ts's source text rather than by importing and running it,
// close the gap without needing to import it:
//   1. bin.ts holds a VALUE import of `normalizeCliCommandAlias` from the registry — so it is
//      wired to delegate.
//   2. bin.ts never itself contains one of the registry's OWN alias tokens as a string literal —
//      so it cannot be re-declaring a parallel mapping instead of actually calling the import
//      (fact 1 alone would still pass if bin.ts imported the function and never called it, or
//      called it beside a leftover local table; fact 2 is what makes the pair exhaustive).
//
// Both were false on the pre-fix bin.ts (no import; both 'long-press' and 'metrics' present as
// literals), so the pair is a real regression pin, not just a description of intent.
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
 * Whether `binSource` holds a VALUE (not type-only) import of `normalizeCliCommandAlias` from
 * the alias registry. Reads `oxc-parser`'s own resolved import-entry table
 * (`module.staticImports`), the same source `zero-dep-jobs.ts`'s `moduleSpecifiers` uses — not a
 * regex, so `import type { normalizeCliCommandAlias as x }` (erased at compile time, no runtime
 * delegation at all) cannot pass as a real import the way a line match on the specifier text
 * would.
 */
export function importsAliasResolver(binSource: string): boolean {
  const parsed = parseSync(BIN_FILE, binSource);
  return parsed.module.staticImports.some((entry) => {
    if (entry.moduleRequest.value !== ALIAS_REGISTRY_SPECIFIER) return false;
    return entry.entries.some(
      (specifier) =>
        !specifier.isType &&
        specifier.importName.kind === 'Name' &&
        specifier.importName.name === ALIAS_RESOLVER_EXPORT,
    );
  });
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
