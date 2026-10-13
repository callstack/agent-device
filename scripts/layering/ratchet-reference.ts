// The ratcheted measurements (R6 type-spine inversions, R9 largest type cycle, R10's R7
// ownership pressure, R75's session authority overlay) and where their reference numbers
// come from: the merge-base with origin/main, measured by the same functions that measure
// the working tree. Growth fails, a shrink needs no edit, and no recorded number can sit
// above what main actually holds.
//
// The base tree is read through the shared committed-tree reader (one `git ls-tree`, one
// `git cat-file --batch`), never a second checkout and never a read per file.

import {
  mergeBaseWithMain,
  readCommittedSources,
  renamedSince,
} from '../__tests__/committed-source-tree.ts';
import {
  largestTypeCycleMembers,
  memoizedImportParser,
  resolveImportEdges,
  targetDagZone,
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
    sessionAuthority: measureSessionAuthorityOverlay(sources, edges),
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
  // Measure the base tree in the working tree's coordinates: a `git mv` since the merge-base
  // (the daemon's move to packages/daemon, 11b) would otherwise make rules keyed on current
  // paths read the base as empty and accept any growth above a zero reference. Edges are
  // resolved in base coordinates first — the base tree is internally consistent — and then
  // the resolved endpoints are canonicalized base -> head, exactly like the eager-closure
  // ratchet canonicalizes entries.
  const baseToHead = new Map(
    [...renamedSince(repoRoot, ref)].map(([headPath, basePath]) => [basePath, headPath]),
  );
  const toHead = (file: string) => baseToHead.get(file) ?? file;
  const baseEdges = resolveImportEdges(
    sources,
    workspaceSpecifierTargetsFromManifests(manifests),
    parse,
  );
  const edges = baseEdges.map((edge) => {
    const file = toHead(edge.file);
    const target = toHead(edge.target);
    return file === edge.file && target === edge.target
      ? edge
      : { ...edge, file, target, fromZone: targetDagZone(file), toZone: targetDagZone(target) };
  });
  const canonical = new Map([...sources].map(([file, text]) => [toHead(file), text]));
  return { ref, ...measureRatchets(canonical, edges) };
}
