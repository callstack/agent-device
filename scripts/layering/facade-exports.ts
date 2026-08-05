// Named-export enumeration for a façade module's own source text — the R11
// structural gate in `package-boundaries.test.ts` uses this to prove a
// façade names its exports explicitly instead of a bare `export *`.
//
// Split out of `package-boundaries.ts` (#1574 review): the boundary rules
// answer "may this file import that one?", while this module answers "what
// does this façade name?" — different questions, so per AGENTS.md they are
// different bounded reads.
//
// This module used to also carry `readFacadeExports`, a ~200-line star-chain
// resolver (`GetExportedNames`/`ResolveExport` re-implemented over relative
// specifiers) that existed only to enumerate what a barrel's `export *`
// hides, feeding a hand-maintained 816-symbol pin table
// (`facade-symbols.ts`, #1574). Every workspace-package façade now names its
// exports explicitly (`export { a, b } from './x.ts'`), so there is nothing
// left for a star-chain walker to resolve — the façade file itself is the
// pin, and `readNamedExports` below is enough to prove it stays that way.

import { parseSync } from 'oxc-parser';

/**
 * Every name a façade module exports, value or type-only, sorted — the exact
 * "named-export-list" a package-boundaries gate can pin (#1555 review P1,
 * "add the reviewer-required exact exported-symbol gate"). Covers both
 * re-export forms (`export { a, b } from './x.ts'`,
 * `export type { a, b } from './x.ts'`, with or without `as` aliasing — the
 * alias is reported, since that is the name a consumer actually imports),
 * `export * as ns from './x.ts'` (one real name, `ns`), and direct
 * declarations (`export function`/`const`/`class`/`type`/`interface`,
 * including `export const a = 1, b = 2`'s multiple declarators). A stray
 * export — intentional or not — changes this list, so a test that pins it
 * exactly turns "the façade grew a symbol" into a loud failure instead of a
 * silent widening only a PR diff review would catch.
 *
 * AST-based (`oxc-parser`, already a devDependency — `session-state.ts` is
 * the existing precedent for using it in this gate), not a regex, for the
 * SAME reason `session-state.ts` gives: a regex has to enumerate every
 * export FORM by hand, and the one it forgets is exactly the one that slips
 * through. That is precisely what happened here (#1555 review, second pass,
 * "the gate also ignores export-star declarations, so it can miss future
 * widening"): `export * from './x.ts'` re-exports an unbounded, statically
 * unknowable set of names — the old regex scanner had no case for it at all,
 * so it silently contributed NOTHING to the list instead of failing loudly.
 * `parsed.module.staticExports` is oxc's own resolved export-entry table
 * (built for exactly this purpose, not re-derived from a manual AST walk),
 * and its `exportName.kind` already draws the line this function needs:
 * `'None'` is bare `export *` (unenumerable — thrown), `'Default'` is
 * `export default …` (also thrown — a facade pinned to an exact named-export
 * list must not carry one), and `'Name'` is every enumerable form above,
 * `export * as ns` included (oxc reports its one real bound name, `ns`).
 */
export function readNamedExports(source: string): string[] {
  const parsed = parseSync('package-boundaries-export-scan.ts', source);
  const names = new Set<string>();
  for (const staticExport of parsed.module.staticExports) {
    for (const entry of staticExport.entries) {
      if (entry.exportName.kind === 'None') {
        throw new Error(
          "readNamedExports cannot enumerate 'export * from …' — it re-exports an unknown set " +
            'of names, exactly the widening an exact-export-list gate exists to catch. Name the ' +
            're-exported symbols explicitly instead of re-exporting the whole module.',
        );
      }
      if (entry.exportName.kind === 'Default') {
        throw new Error(
          "readNamedExports cannot enumerate 'export default …' as a named symbol — a facade a " +
            'caller pins to an exact named-export list must not carry a default export.',
        );
      }
      if (entry.exportName.name) names.add(entry.exportName.name);
    }
  }
  return [...names].sort();
}

/**
 * Every name a module declares or re-exports BY NAME, ignoring any bare
 * `export *` it also carries. `readNamedExports` refuses such a module
 * outright, which is right for a façade — a star there is unbounded widening —
 * but wrong for a SOURCE the exhaustiveness gate is reading: skipping the whole
 * file also skips its direct exports, so removing one of those from a façade
 * would narrow the surface undetected (#1614 review P2). The starred names are
 * not lost: a façade must re-export the starred module directly too, and that
 * path is checked on its own.
 */
export function readDirectNamedExports(source: string): string[] {
  const parsed = parseSync('facade-source-export-scan.ts', source);
  const names = new Set<string>();
  for (const staticExport of parsed.module.staticExports) {
    for (const entry of staticExport.entries) {
      // `None` is the bare star (unenumerable here, covered elsewhere);
      // `Default` is never reachable through a star re-export.
      if (entry.exportName.kind !== 'Name') continue;
      if (entry.exportName.name) names.add(entry.exportName.name);
    }
  }
  return [...names].sort();
}
