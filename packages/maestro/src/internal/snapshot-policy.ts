import {
  isUsefulVisibilityAnchor,
  type SnapshotVisibility,
} from '@agent-device/contracts/snapshot';
import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';

export function isMaestroNodeVisible(
  node: SnapshotNode,
  visibility: SnapshotVisibility,
  platform: 'android' | 'ios',
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  if (isPositiveFiniteRect(node.rect)) {
    return visibility.isVisibleInEffectiveViewport(node);
  }
  if (node.rect) return false;
  if (platform !== 'android' && node.hittable === true) return true;
  const anchor = visibility.findAncestor(node, (parent) =>
    isUsefulVisibilityAnchor(parent, platform) ? parent : null,
  );
  if (!anchor) return false;
  if (!isPositiveFiniteRect(anchor.rect)) {
    return platform !== 'android' && anchor.hittable === true;
  }
  return visibility.isVisibleInEffectiveViewport(anchor);
}

export function isDescendantOfSnapshotNode(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  visibility: SnapshotVisibility,
): boolean {
  return Boolean(
    visibility.findAncestor(node, (candidate) =>
      candidate.index === ancestor.index ? candidate : null,
    ),
  );
}
