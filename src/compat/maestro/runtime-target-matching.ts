import type { SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildSnapshotNodeByIndex,
  isDescendantOfSnapshotNode,
} from '../../snapshot/snapshot-processing.ts';
import type { MaestroSelector } from './program-ir.ts';
import { matchesMaestroTypedSelector } from './runtime-target-policy.ts';

/** Resolve a source-preserving Maestro selector without stringifying it. */
export function findMaestroTypedSelectorMatches(
  snapshot: SnapshotState,
  selector: MaestroSelector,
): SnapshotNode[] {
  return snapshot.nodes.filter((node) => matchesMaestroTypedSelector(node, selector));
}

export function scopeMaestroMatchesByAncestor(
  snapshot: SnapshotState,
  matches: SnapshotNode[],
  childOf: MaestroSelector | undefined,
): { matches: SnapshotNode[]; parentMatched: boolean } {
  if (!childOf) return { matches, parentMatched: true };
  const parents = findMaestroTypedSelectorMatches(snapshot, childOf);
  if (parents.length === 0) return { matches: [], parentMatched: false };
  const nodeByIndex = buildSnapshotNodeByIndex(snapshot.nodes);
  return {
    matches: matches.filter((node) =>
      parents.some((parent) =>
        isDescendantOfSnapshotNode(snapshot.nodes, node, parent, nodeByIndex),
      ),
    ),
    parentMatched: true,
  };
}
