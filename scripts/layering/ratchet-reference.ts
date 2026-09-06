// The ratcheted measurements (R6 type-spine inversions, R9 largest type cycle, R10's R7
// ownership pressure, R75's session authority overlay) and where their reference numbers
// come from: the merge-base with origin/main, measured by the same functions that measure
// the working tree. Growth fails, a shrink needs no edit, and no recorded number can sit
// above what main actually holds.
//
// The base tree is read through the shared committed-tree reader (one `git ls-tree`, one
// `git cat-file --batch`), never a second checkout and never a read per file.

import { mergeBaseWithMain, readCommittedSources } from '../__tests__/committed-source-tree.ts';
import {
  largestTypeCycleMembers,
  memoizedImportParser,
  resolveImportEdges,
  typeInversionCounts,
  type ImportParser,
  type ResolvedImportEdge,
} from './model.ts';
import { workspaceSpecifierTargetsFromManifests } from './package-boundaries.ts';
import {
  measureSessionAuthorityOverlay,
  type SessionAuthorityOverlay,
} from './session-authority-overlay.ts';
import { sessionStateWritePressure, type SessionStateWritePressure } from './session-state.ts';

export type LayeringRatchets = Readonly<{
  /** R6: distinct type-only spine inversions per `from -> to` zone pair. */
  typeInversions: Readonly<Record<string, number>>;
  /** R9 and R10's zone membership: sorted members of the largest type-level cycle. */
  largestTypeCycle: readonly string[];
  /** R10: R7 ownership pressure. */
  sessionState: SessionStateWritePressure;
  /** R75: SessionState-shape / SessionStore-authority overlay, full production scope. */
  sessionAuthority: SessionAuthorityOverlay;
}>;

export type MergeBaseRatchets = LayeringRatchets & Readonly<{ ref: string }>;

export function measureRatchets(
  sources: ReadonlyMap<string, string>,
  edges: readonly ResolvedImportEdge[],
): LayeringRatchets {
  return {
    typeInversions: typeInversionCounts(edges),
    largestTypeCycle: largestTypeCycleMembers(edges),
    sessionState: sessionStateWritePressure(sources),
    sessionAuthority: measureSessionAuthorityOverlay(edges),
  };
}

/**
 * The reference measurement: the merge-base tree, enumerated and classified by the same reader
 * the eager-closure ratchet uses, then measured exactly like the working tree. A file whose text
 * is byte-identical at both ends costs no second parse, because `parse` memoizes by source text.
 */
export function mergeBaseRatchets(
  repoRoot: string,
  parse: ImportParser = memoizedImportParser(),
): MergeBaseRatchets {
  const ref = mergeBaseWithMain(repoRoot);
  const { sources, manifests } = readCommittedSources(repoRoot, ref);
  const edges = resolveImportEdges(
    sources,
    workspaceSpecifierTargetsFromManifests(manifests),
    parse,
  );
  return { ref, ...measureRatchets(sources, edges) };
}
