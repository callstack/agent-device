// Catches: two modules of one package exporting the same name in the type namespace —
//   `export type PointTarget` in client-target.ts and in interaction.ts compiled fine, and a
//   barrel or a consumer importing the name got whichever module it happened to name, so the
//   two same-named types could silently drift apart while every import site stayed green.
// Evidence: the Q6 name-intersection scan found 11 such collisions (5 in packages/contracts,
//   1 each in command-runtime, daemon and platform-apple, 3 in maestro); each was fixed by
//   renaming the internal declaration, never the public one.
// Cost: one AST pass per production source plus a memoized re-export resolution.
// Kill criterion: none enforced today; retire only by maintainer decision that one package may
//   again export two different types under one name.
//
// The rule resolves re-exports transitively, so a barrel re-exporting a declaration is the
// SAME symbol, not a collision: only names whose ultimate origins differ are reported. An
// alias across a package boundary (a package re-exporting another package's type under the
// same name) stays legal — the rule groups by the exporting file's package, and one external
// origin is not a duplicate.

import { parseSync } from 'oxc-parser';
import path from 'node:path';
import type { LayeringViolation } from './model.ts';
import type { ProductionSource } from './layering-ast.ts';

export const UNIQUE_EXPORTED_TYPE_NAMES_RULE = 'R87 unique-exported-type-names';

/** A name's ultimate origin: a repo-relative declaring file, or an external specifier. */
type Origin = string;

type ExportSite = Readonly<{ origin: Origin; file: string; line: number }>;

/** Full import specifier -> repo-relative source target (from workspace package.json#exports). */
export type SpecifierTargets = ReadonlyMap<string, string>;

const DECLARATION_TYPES = new Set([
  'TSTypeAliasDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
  'ClassDeclaration',
]);

/**
 * Every type-namespace name one module exports, resolved to its ultimate origin. Explicit
 * exports shadow star re-exports (ES semantics); two stars bringing one name from different
 * origins keep both origins so the collision is reported rather than silently dropped.
 */
export function uniqueExportedTypeNamesViolations(
  sources: readonly ProductionSource[],
  specifierTargets: SpecifierTargets = new Map(),
): LayeringViolation[] {
  const byPath = new Map(sources.map((source) => [source.path, source.source]));
  const exportsCache = new Map<string, Map<string, ExportSite>>();

  const exportsOf = (file: string, stack: readonly string[]): Map<string, ExportSite> => {
    const cached = exportsCache.get(file);
    if (cached) return cached;
    const out = new Map<string, ExportSite>();
    exportsCache.set(file, out); // set before recursion: a re-export cycle resolves to nothing
    const source = byPath.get(file);
    if (source === undefined || stack.includes(file)) return out;

    const origins = new Map<string, Set<Origin>>();
    const sites = new Map<string, ExportSite>();
    const shadowed = new Set<string>();
    const add = (name: string, site: ExportSite, shadow: boolean): void => {
      if (!shadow && shadowed.has(name)) return; // an explicit export always wins over a star
      const existing = origins.get(name);
      if (shadow) {
        origins.set(name, new Set([site.origin]));
        shadowed.add(name);
      } else if (existing) existing.add(site.origin);
      else origins.set(name, new Set([site.origin]));
      if (!sites.has(name)) sites.set(name, site);
    };

    const localDeclarations = new Map<string, number>();
    const imports = new Map<string, { spec: string; imported: string }>();

    const resolveSpec = (fromFile: string, spec: string): Origin => {
      if (spec.startsWith('.')) {
        return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
      }
      return specifierTargets.get(spec) ?? spec;
    };
    /** The type-namespace export of `name` in the module `spec` resolves to, if any. */
    const typeExportOf = (fromFile: string, spec: string, name: string): ExportSite | undefined => {
      const target = resolveSpec(fromFile, spec);
      if (!byPath.has(target)) return undefined;
      return exportsOf(target, [...stack, file]).get(name);
    };

    const program = parseSync(file, source).program;
    for (const statement of program.body as unknown as Record<string, unknown>[]) {
      if (statement.type === 'ImportDeclaration') {
        const spec = (statement.source as { value?: string } | null)?.value;
        if (!spec) continue;
        for (const specifier of (statement.specifiers ?? []) as Record<string, unknown>[]) {
          if (specifier.type !== 'ImportSpecifier') continue;
          const local = (specifier.local as { name?: string } | null)?.name;
          const imported = specifier.imported as { name?: string; value?: string } | null;
          if (local && imported) {
            imports.set(local, { spec, imported: imported.name ?? imported.value ?? local });
          }
        }
        continue;
      }
      if (statement.type === 'ExportNamedDeclaration') {
        const declaration = statement.declaration as Record<string, unknown> | null;
        if (declaration && DECLARATION_TYPES.has(declaration.type as string)) {
          const name = (declaration.id as { name?: string } | null)?.name;
          if (name) {
            localDeclarations.set(name, lineAt(source, Number(declaration.start ?? 0)));
            add(
              name,
              { origin: file, file, line: lineAt(source, Number(statement.start ?? 0)) },
              true,
            );
          }
          continue;
        }
        const spec = (statement.source as { value?: string } | null)?.value;
        const declarationKind = statement.exportKind as string | undefined;
        for (const specifier of (statement.specifiers ?? []) as Record<string, unknown>[]) {
          if (specifier.type !== 'ExportSpecifier') continue;
          const exported = (specifier.exported as { name?: string } | null)?.name;
          const local = (specifier.local as { name?: string } | null)?.name;
          if (!exported || !local) continue;
          const isTypeEntry = declarationKind === 'type' || specifier.exportKind === 'type';
          const line = lineAt(source, Number(specifier.start ?? statement.start ?? 0));
          if (spec) {
            // Re-export from another module. A value-kind entry still carries the name's type
            // meaning when the target exports it in the type namespace; an external target
            // proves nothing either way, so only type-kind entries are followed there.
            const site = typeExportOf(file, spec, local);
            if (site) add(exported, { ...site, file, line }, true);
            else if (isTypeEntry)
              add(exported, { origin: resolveSpec(file, spec), file, line }, true);
            continue;
          }
          // Local export list: the name is declared here, imported here, or (type-kind only)
          // assumed local.
          const localLine = localDeclarations.get(local);
          if (localLine !== undefined) {
            add(exported, { origin: file, file, line: localLine }, true);
            continue;
          }
          const imported = imports.get(local);
          if (imported) {
            const site = typeExportOf(file, imported.spec, imported.imported);
            if (site) add(exported, { ...site, file, line }, true);
            else if (isTypeEntry) {
              add(exported, { origin: resolveSpec(file, imported.spec), file, line }, true);
            }
            continue;
          }
          if (isTypeEntry) add(exported, { origin: file, file, line }, true);
        }
        continue;
      }
      if (statement.type === 'ExportAllDeclaration') {
        const spec = (statement.source as { value?: string } | null)?.value;
        if (!spec) continue;
        const target = resolveSpec(file, spec);
        if (!byPath.has(target)) continue;
        const line = lineAt(source, Number(statement.start ?? 0));
        for (const [name, site] of exportsOf(target, [...stack, file])) {
          add(name, { ...site, file, line }, false);
        }
        continue;
      }
      // Non-exported declarations still matter: `type X = …; export type { X };` exports X.
      if (DECLARATION_TYPES.has(statement.type as string)) {
        const name = ((statement as Record<string, unknown>).id as { name?: string } | null)?.name;
        if (name) localDeclarations.set(name, lineAt(source, Number(statement.start ?? 0)));
      }
    }

    for (const [name, nameOrigins] of origins) {
      const site = sites.get(name)!;
      if (nameOrigins.size === 1) {
        out.set(name, site);
      } else {
        // A star-star conflict keeps several origins on one name; report each origin once.
        // Identifiers cannot contain '@', so the composite key is unambiguous.
        for (const origin of nameOrigins) out.set(`${name}@${origin}`, { ...site, origin });
      }
    }
    return out;
  };

  // Group every exported type name by the exporting file's package; a name with more than one
  // ultimate origin inside one package is a collision. Cross-package aliases (one external
  // origin) are legal at layer seams.
  const byPackage = new Map<string, Map<string, Map<Origin, ExportSite>>>();
  for (const source of sources) {
    const pkg = packageOf(source.path);
    if (!byPackage.has(pkg)) byPackage.set(pkg, new Map());
    const names = byPackage.get(pkg)!;
    for (const [key, site] of exportsOf(source.path, [])) {
      const name = key.includes('@') ? key.slice(0, key.indexOf('@')) : key;
      if (!names.has(name)) names.set(name, new Map());
      const origins = names.get(name)!;
      if (!origins.has(site.origin)) origins.set(site.origin, site);
    }
  }

  const violations: LayeringViolation[] = [];
  for (const [pkg, names] of [...byPackage.entries()].sort()) {
    for (const [name, origins] of [...names.entries()].sort()) {
      if (origins.size <= 1) continue;
      const originList = [...origins.keys()].sort().join(', ');
      for (const site of origins.values()) {
        violations.push({
          rule: UNIQUE_EXPORTED_TYPE_NAMES_RULE,
          file: site.file,
          line: site.line,
          message:
            `type name '${name}' is exported from ${origins.size} different modules of ${pkg} ` +
            `(${originList}); one name must mean one type inside a package — rename all but one ` +
            `(cross-package aliases stay legal)`,
        });
      }
    }
  }
  return violations;
}

function packageOf(file: string): string {
  const match = /^packages\/([^/]+)\//.exec(file);
  return match ? `packages/${match[1]}` : 'src (root package)';
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}
