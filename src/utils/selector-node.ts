import type { Platform } from '../kernel/device.ts';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { isFillableType } from '../snapshot/snapshot-processing.ts';

export function isNodeVisible(node: SnapshotNode): boolean {
  if (node.hittable === true) return true;
  if (!node.rect) return false;
  return node.rect.width > 0 && node.rect.height > 0;
}

export function isNodeEditable(node: SnapshotNode, platform: Platform): boolean {
  return isFillableType(node.type ?? '', platform) && node.enabled !== false;
}
