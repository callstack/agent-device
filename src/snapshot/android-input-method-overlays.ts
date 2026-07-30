import { classifyAndroidInputOwnership } from '../contracts/android-input-ownership.ts';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

export function isAndroidInputMethodSnapshotNode(
  node: Pick<RawSnapshotNode, 'bundleId' | 'identifier'> | undefined,
): boolean {
  if (!node) return false;
  return classifyAndroidInputOwnership({
    packageName: node.bundleId,
    resourceId: node.identifier,
  }).inputMethodOwned;
}
