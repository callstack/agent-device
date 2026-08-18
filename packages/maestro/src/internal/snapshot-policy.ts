import {
  buildSnapshotNodeMap,
  findSnapshotAncestor,
  isNodeVisibleInEffectiveViewport,
  isUsefulVisibilityAnchor,
} from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

export function isMaestroNodeVisible(
  node: SnapshotNode,
  nodes: SnapshotNode[],
  platform: 'android' | 'ios',
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  const byIndex = buildSnapshotNodeMap(nodes);
  if (isPositiveFiniteRect(node.rect)) {
    return isNodeVisibleInEffectiveViewport(node, nodes, byIndex);
  }
  if (node.rect) return false;
  if (platform !== 'android' && node.hittable === true) return true;
  const anchor = findSnapshotAncestor(nodes, node, byIndex, (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
  if (!anchor) return false;
  if (!isPositiveFiniteRect(anchor.rect)) {
    return platform !== 'android' && anchor.hittable === true;
  }
  return isNodeVisibleInEffectiveViewport(anchor, nodes, byIndex);
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
