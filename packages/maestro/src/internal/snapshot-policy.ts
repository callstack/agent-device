import {
  buildSnapshotNodeMap,
  collectViewportRects,
  findSnapshotAncestor,
  isNodeVisibleInEffectiveViewport,
  isUsefulVisibilityAnchor,
} from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

export type MaestroVisibilityContext = {
  readonly nodes: SnapshotNode[];
  readonly nodeByIndex: ReadonlyMap<number, SnapshotNode>;
  readonly viewportRects: readonly Rect[];
};

export function buildMaestroVisibilityContext(nodes: SnapshotNode[]): MaestroVisibilityContext {
  return {
    nodes,
    nodeByIndex: buildSnapshotNodeMap(nodes),
    viewportRects: collectViewportRects(nodes),
  };
}

export function isMaestroNodeVisible(
  node: SnapshotNode,
  context: MaestroVisibilityContext,
  platform: 'android' | 'ios',
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  if (isPositiveFiniteRect(node.rect)) {
    return isNodeVisibleInEffectiveViewport(
      node,
      context.nodes,
      context.nodeByIndex,
      context.viewportRects,
    );
  }
  if (node.rect) return false;
  if (platform !== 'android' && node.hittable === true) return true;
  const anchor = findSnapshotAncestor(context.nodes, node, context.nodeByIndex, (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
  if (!anchor) return false;
  if (!isPositiveFiniteRect(anchor.rect)) {
    return platform !== 'android' && anchor.hittable === true;
  }
  return isNodeVisibleInEffectiveViewport(
    anchor,
    context.nodes,
    context.nodeByIndex,
    context.viewportRects,
  );
}

export function isDescendantOfSnapshotNode(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodeByIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  return Boolean(
    findSnapshotAncestor(nodes, node, nodeByIndex, (candidate) =>
      candidate.index === ancestor.index ? candidate : null,
    ),
  );
}
