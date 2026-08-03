// Façade export enumeration: what names a module actually exposes to a
// consumer, for the R11 exact-symbol pins in `package-boundaries.test.ts`.
//
// Split out of `package-boundaries.ts` (#1574 review): the boundary rules
// answer "may this file import that one?", while this module answers "what
// does this façade name?" — different questions, so per AGENTS.md they are
// different bounded reads.

import fs from 'node:fs';
import path from 'node:path';
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
 * Every name a façade subpath exports, sorted — `readNamedExports` widened
 * from one source string to the re-export CHAIN behind it, so a barrel
 * façade is pinnable too.
 *
 * `readNamedExports` throws on bare `export * from './x.ts'` because, given
 * only a source string, the set it contributes is genuinely unknowable. Given
 * the FILE, it is not: the specifier names a sibling module the gate can read
 * and enumerate in turn. That is the whole difference here — every
 * `@agent-device/contracts` façade (`src/facades/*.ts`) is exactly such a
 * barrel, 13 of the 14 subpaths being nothing but bare re-export lines, so
 * without chain resolution the package with the largest and fastest-growing
 * public surface in the workspace is the one package that cannot be pinned.
 *
 * The walk models what `export *` ACTUALLY re-exports, which is narrower than
 * "every name in the child" in two ways a naive union gets wrong (#1574
 * review P1):
 *
 * 1. **`default` is excluded.** Per `GetExportedNames`, a star export skips
 *    the child's default entirely. A private `export default` in a leaf is
 *    not reachable through the barrel and does not widen the façade, so it is
 *    passed over rather than rejected. A default on the ENTRY file is still a
 *    real default export of the façade itself, and still throws.
 * 2. **A name from two different star sources is ambiguous, not exported.**
 *    `ResolveExport` returns `ambiguous` when star resolution finds two
 *    distinct bindings for one name, and importing it is then a `SyntaxError`
 *    — the name is not part of the surface at all. Unioning would silently
 *    pin a symbol no consumer can import, so ambiguity throws instead, naming
 *    both origins. A diamond (two barrels reaching the SAME declaration) is
 *    not ambiguous and resolves normally, which is why origins are tracked by
 *    the binding a name ultimately resolves to — through a chain of named
 *    re-exports, not just the immediate source — rather than by path taken.
 *    An explicit export in a module shadows any star-provided name of the
 *    same name, exactly as the spec's own precedence does.
 *
 * Resolution is deliberately narrow — a RELATIVE specifier only, and the
 * repo's explicit-`.ts`-extension convention means the specifier is already
 * the path. A bare star across a PACKAGE specifier still throws: enumerating
 * it means resolving `node_modules` and re-entering another package's
 * `exports` map, and a façade that re-exports a whole other package wholesale
 * is precisely the unbounded widening this gate exists to refuse. Cycles are
 * visit-guarded (a barrel pair that re-exported each other would otherwise
 * recurse forever).
 */
export function readFacadeExports(entryFile: string): string[] {
  // `${declaringFile}#${name}` — binding identity, so the same declaration
  // reached by two different barrel paths is one origin, not two.
  const cache = new Map<string, Map<string, string>>();
  const walking = new Set<string>();

  /**
   * The binding a named re-export ULTIMATELY names, not the module it was
   * written against (#1574 review P1). `a` re-exports `x` from `b`, `c`
   * re-exports `x` from `a`, and a façade stars both: ESM resolves one `b#x`
   * binding, so that is a diamond, not a clash. Stopping at the immediate
   * source would identify the two paths as `b#x` and `a#x` and falsely reject
   * the façade as ambiguous. The child's own map already carries
   * fully-resolved origins, so asking it is the whole fix.
   */
  const reExportOrigin = (
    from: string,
    specifier: string | undefined,
    importedName: string,
    localName: string,
  ): string => {
    if (!specifier) return `${from}#${localName}`;
    // A package specifier is not a file this gate reads; its name is a stable
    // identity of its own, so two façades re-exporting the same symbol from
    // the same package still agree.
    if (!specifier.startsWith('.')) return `${specifier}#${importedName}`;
    const childPath = path.resolve(path.dirname(from), specifier);
    // Falls back to the immediate source when the child does not name it — a
    // cycle in progress, or a name oxc cannot attribute.
    return exportedNames(childPath).get(importedName) ?? `${childPath}#${importedName}`;
  };

  const exportedNames = (file: string): Map<string, string> => {
    const resolved = path.resolve(file);
    const cached = cache.get(resolved);
    if (cached) return cached;
    // A cycle contributes nothing further; whatever it exports is reached by
    // the path that entered it first.
    if (walking.has(resolved)) return new Map();
    walking.add(resolved);

    const parsed = parseSync(resolved, fs.readFileSync(resolved, 'utf8'));
    const explicit = new Map<string, string>();
    const starOrigins = new Map<string, Map<string, string>>();

    for (const staticExport of parsed.module.staticExports) {
      for (const entry of staticExport.entries) {
        const specifier = entry.moduleRequest?.value;

        if (entry.exportName.kind === 'Default') {
          // Only the façade's own default is a default export of the façade.
          if (resolved === path.resolve(entryFile)) {
            throw new Error(
              `readFacadeExports cannot enumerate 'export default …' as a named symbol ` +
                `(${resolved}) — a facade a caller pins to an exact named-export list must not ` +
                'carry one.',
            );
          }
          continue;
        }

        if (entry.exportName.kind === 'None') {
          if (!specifier || !specifier.startsWith('.')) {
            throw new Error(
              `readFacadeExports cannot enumerate 'export * from ${specifier ?? '…'}' ` +
                `(${resolved}) — only a relative re-export names a module this gate can read ` +
                'and enumerate in turn. Name the re-exported symbols explicitly instead.',
            );
          }
          const childPath = path.resolve(path.dirname(resolved), specifier);
          for (const [name, origin] of exportedNames(childPath)) {
            // `default` is filtered HERE, at the star, not at the source
            // (#1574 review, third round). A child's `export { default } from
            // './leaf.ts'` is a NAMED export whose name happens to be
            // `default` — oxc reports it as kind `Name`, and it must stay in
            // the child's map so a chain like `export { default as x } from
            // './that-child.ts'` can resolve its binding. But a star must not
            // re-export it: `GetExportedNames` skips `default`, and oxc names
            // the star's own import `AllButDefault`. Filtering at the source
            // would break identity resolution; filtering here is the spec's
            // own split.
            if (name === 'default') continue;
            let origins = starOrigins.get(name);
            if (!origins) starOrigins.set(name, (origins = new Map()));
            origins.set(origin, specifier);
          }
          continue;
        }

        const name = entry.exportName.name;
        if (!name) continue;
        explicit.set(
          name,
          reExportOrigin(resolved, specifier, entry.importName?.name ?? name, name),
        );
      }
    }

    const names = new Map(explicit);
    for (const [name, origins] of starOrigins) {
      if (explicit.has(name)) continue; // explicit export shadows the star
      if (origins.size > 1) {
        throw new Error(
          `readFacadeExports found '${name}' re-exported by ${origins.size} different ` +
            `'export *' sources in ${resolved} (${[...origins.values()].sort().join(', ')}). ` +
            'ESM resolves that to `ambiguous`, so the name is not importable at all and must ' +
            'not be pinned as part of the surface. Re-export it explicitly from one source.',
        );
      }
      names.set(name, [...origins.keys()][0]!);
    }

    walking.delete(resolved);
    cache.set(resolved, names);
    return names;
  };

  const names = exportedNames(entryFile);
  // The entry's own default, in EITHER form. `export default …` throws above
  // as it is parsed; `export { default } from './x.ts'` reaches here instead,
  // because oxc reports it as a named export called `default` — a different
  // parse shape for the same fact, that the façade carries a default export.
  if (names.has('default')) {
    throw new Error(
      `readFacadeExports cannot enumerate a default export as a named symbol ` +
        `(${path.resolve(entryFile)}) — a facade a caller pins to an exact named-export list ` +
        'must not carry one, whether declared or re-exported under the name `default`.',
    );
  }
  return [...names.keys()].sort();
}
