import { classifyAndroidInputOwnership } from '../core/android-input-ownership.ts';
import type { RawSnapshotNode } from '../kernel/snapshot.ts';

export function isAndroidInputMethodSnapshotNode(
  node: Pick<RawSnapshotNode, 'bundleId' | 'identifier'> | undefined,
): boolean {
  if (!node) return false;
  return classifyAndroidInputOwnership({
    packageName: node.bundleId,
    resourceId: node.identifier,
  }).inputMethodOwned;
}
