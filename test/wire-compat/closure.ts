/**
 * The closure walk: does every type a listed wire declaration references land
 * somewhere someone wrote down? (#1432, review P1.)
 *
 * Extracted from the gate test so the planted-red proofs in
 * `wire-mutations.test.ts` exercise the SAME walk the gate runs. A red proof
 * against a second copy of the logic proves nothing about the gate.
 */

import { readTopLevelDeclarationNames, readTypeReferences } from './declaration-digest.ts';
import { createOriginResolver } from './module-resolution.ts';
import type { WireDeclarationRef } from './surface.ts';

export type ClosureGaps = {
  /** Repo declarations reached by the walk that are neither listed nor waived. */
  omitted: string[];
  /** Names nothing could place — the fail-closed case. */
  unresolved: string[];
};

export function findClosureGaps(options: {
  repoRoot: string;
  readSource: (file: string) => string;
  declarations: readonly WireDeclarationRef[];
  /** Keys (`<file>#<name>`) treated as covered; normally every listed declaration. */
  claimed: ReadonlySet<string>;
  waivers: Readonly<Record<string, string>>;
  isExternalSpecifier: (specifier: string) => boolean;
}): ClosureGaps {
  const { repoRoot, readSource, declarations, claimed, waivers, isExternalSpecifier } = options;

  const declaredNames = new Map<string, Set<string>>();
  const declaresLocally = (file: string, name: string): boolean => {
    let names = declaredNames.get(file);
    if (!names) {
      names = new Set(readTopLevelDeclarationNames(file, readSource(file)));
      declaredNames.set(file, names);
    }
    return names.has(name);
  };

  const resolveOrigin = createOriginResolver({
    repoRoot,
    readSource,
    declaresLocally,
    isExternalSpecifier,
  });

  const omitted = new Set<string>();
  const unresolved = new Set<string>();
  for (const ref of declarations) {
    for (const name of readTypeReferences(ref.file, readSource(ref.file), ref.name)) {
      const origin = resolveOrigin(ref.file, name);
      if (origin.kind === 'global' || origin.kind === 'external') continue;
      if (origin.kind === 'unresolved') {
        unresolved.add(`${name} (referenced by ${ref.name} in ${ref.file})`);
        continue;
      }
      const key = `${origin.file}#${origin.name}`;
      if (claimed.has(key) || key in waivers) continue;
      omitted.add(`${key} (reached from ${ref.name} in ${ref.file})`);
    }
  }

  return { omitted: [...omitted].sort(), unresolved: [...unresolved].sort() };
}
