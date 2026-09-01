import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';

export function forEachOtherNodeWithLabel(
  nodes: RawSnapshotNode[],
  visitor: (node: RawSnapshotNode, label: string, position: number) => void,
): void {
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    const label = node?.label?.trim();
    if (node && label && normalizeType(node.type ?? '') === 'other') {
      visitor(node, label, position);
    }
  }
}
