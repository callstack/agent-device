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

export function countMaestroDispatchCandidates(
  snapshot: SnapshotState,
  matches: SnapshotNode[],
): number {
  const nodeByIndex = buildSnapshotNodeByIndex(snapshot.nodes);
  const groups: SnapshotNode[][] = [];
  for (const match of [...matches].sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0))) {
    const group = groups.find((candidates) =>
      candidates.every(
        (candidate) =>
          sameRect(match, candidate) &&
          (isDescendantOfSnapshotNode(snapshot.nodes, match, candidate, nodeByIndex) ||
            isDescendantOfSnapshotNode(snapshot.nodes, candidate, match, nodeByIndex)),
      ),
    );
    if (group) group.push(match);
    else groups.push([match]);
  }
  return groups.length;
}

function sameRect(left: SnapshotNode, right: SnapshotNode): boolean {
  const a = left.rect;
  const b = right.rect;
  return Boolean(
    a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height,
  );
}
