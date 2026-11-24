import type { SnapshotScreenReaderOrderEvidence } from '@agent-device/contracts/capture';
import type { AndroidBuiltSnapshot } from './ui-hierarchy.ts';
import type { AndroidNode } from './ui-hierarchy-node.ts';
import { estimateTalkBackOrder } from './screen-reader-order.ts';

/**
 * The TalkBack order estimate as presented node indexes. A stop the presentation hides, such as a
 * label-less container TalkBack reads as one, is listed by its first presented descendant that is
 * not a stop of its own.
 */
export function buildAndroidScreenReaderOrderEvidence(
  tree: AndroidNode,
  snapshot: Pick<AndroidBuiltSnapshot, 'nodes' | 'sourceNodes'>,
): SnapshotScreenReaderOrderEvidence | undefined {
  const windows = estimateTalkBackOrder(tree);
  if (!windows) return undefined;
  const presented = new Map<AndroidNode, number>();
  snapshot.sourceNodes.forEach((source, position) => {
    const node = snapshot.nodes[position];
    if (node) presented.set(source, node.index);
  });
  const stops = new Set(windows.flat());
  return {
    windows: windows.map((windowStops) => {
      const nodeIndexes: number[] = [];
      let omittedStops = 0;
      for (const stop of windowStops) {
        const index = presented.get(stop) ?? firstPresentedDescendant(stop, presented, stops);
        if (index === undefined || nodeIndexes.includes(index)) omittedStops += 1;
        else nodeIndexes.push(index);
      }
      return { nodeIndexes, omittedStops };
    }),
  };
}

function firstPresentedDescendant(
  node: AndroidNode,
  presented: ReadonlyMap<AndroidNode, number>,
  stops: ReadonlySet<AndroidNode>,
): number | undefined {
  for (const child of node.children) {
    if (stops.has(child)) continue;
    const index = presented.get(child) ?? firstPresentedDescendant(child, presented, stops);
    if (index !== undefined) return index;
  }
  return undefined;
}
