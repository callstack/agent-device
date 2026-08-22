import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import { normalizeRect } from '../utils/rect-center.ts';

/**
 * The three whole-tree lookups actionability resolution performs per node, read
 * once instead of rebuilt per node: parents by index, children by parent, and
 * the viewport rects an overly-broad ancestor is measured against.
 *
 * It exists because ranking asks the SAME policy about many candidates. One
 * `find <text> click` with `m` matches over an `n`-node capture used to walk the
 * whole tree three times per candidate before it could refuse or act; with this
 * it walks it once for the pass.
 *
 * Read-only and scoped to one pass over one node array. A topology that outlived
 * its capture would answer for a screen that has already moved, so nothing caches
 * it on a session — build it from the exact array being ranked and drop it with
 * that pass.
 *
 * `nodesByIndex` is handed to `findNearestAncestor` in
 * `@agent-device/contracts/snapshot-tree`. #1690 names
 * `src/snapshot/snapshot-processing.ts` as that function's home; the path no
 * longer exists and the contracts module is the seam that replaced it, so read
 * the issue's file list as drifted, not as a second place to change.
 */
export type ActionableTouchTopology = {
  /** Parent resolution by `node.index` — snapshot identity, not array position. */
  readonly nodesByIndex: ReadonlyMap<number, SnapshotNode>;
  /** Children of each parent index, in the input array's order. */
  readonly childrenByParentIndex: ReadonlyMap<number, readonly SnapshotNode[]>;
  /**
   * Normalized rects of the canonical viewport roots, in the input array's order.
   * NOT interchangeable with `snapshot-visibility`'s `precomputedViewportRects`:
   * `normalizeRect` drops negative width/height, `hasValidRect` there keeps them,
   * so substituting one for the other changes which rect wins `pickLargestRect`.
   */
  readonly viewportRootRects: readonly Rect[];
};

/**
 * One pass, three collections. Deliberately written with `for...of` rather than
 * `filter`/`map`: the ranking regression counts whole-array scans on the node
 * array, and the point of this builder is that a ranking pass performs exactly
 * one of them.
 */
export function buildActionableTouchTopology(
  nodes: readonly SnapshotNode[],
): ActionableTouchTopology {
  const nodesByIndex = new Map<number, SnapshotNode>();
  const childrenByParentIndex = new Map<number, SnapshotNode[]>();
  const viewportRootRects: Rect[] = [];
  for (const node of nodes) {
    nodesByIndex.set(node.index, node);
    if (typeof node.parentIndex === 'number') {
      const siblings = childrenByParentIndex.get(node.parentIndex);
      if (siblings) siblings.push(node);
      else childrenByParentIndex.set(node.parentIndex, [node]);
    }
    if (isViewportRootNode(node)) {
      const rect = normalizeRect(node.rect);
      if (rect) viewportRootRects.push(rect);
    }
  }
  return { nodesByIndex, childrenByParentIndex, viewportRootRects };
}
