import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  extractNodeText,
  isMeaningfulLabel,
  normalizeType,
} from '@agent-device/contracts/snapshot';

export function normalizeSnapshotTree(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const originalToNormalizedIndex = new Map<number, number>();
  for (const [position, node] of nodes.entries()) {
    originalToNormalizedIndex.set(node.index, position);
  }

  const normalized: RawSnapshotNode[] = [];
  const ancestorStack: Array<{ depth: number; index: number }> = [];

  for (const [position, node] of nodes.entries()) {
    const depth = Math.max(0, node.depth ?? 0);
    while (ancestorStack.length > 0 && depth <= ancestorStack.at(-1)!.depth) {
      ancestorStack.pop();
    }

    const index = position;
    const explicitParentIndex =
      typeof node.parentIndex === 'number'
        ? originalToNormalizedIndex.get(node.parentIndex)
        : undefined;
    const parentIndex =
      typeof explicitParentIndex === 'number' && explicitParentIndex < index
        ? explicitParentIndex
        : ancestorStack.at(-1)?.index;
    normalized.push({
      ...node,
      index,
      depth,
      parentIndex,
    });
    ancestorStack.push({ depth, index });
  }

  return normalized;
}

export function pruneGroupNodes(nodes: RawSnapshotNode[]): RawSnapshotNode[] {
  const skippedDepths: number[] = [];
  const result: RawSnapshotNode[] = [];
  for (const node of nodes) {
    const depth = node.depth ?? 0;
    while (skippedDepths.length > 0 && depth <= skippedDepths.at(-1)!) {
      skippedDepths.pop();
    }
    const type = normalizeType(node.type ?? '');
    const hasMeaningfulLabel = isMeaningfulLabel(extractNodeText(node));
    if ((type === 'group' || type === 'ioscontentgroup') && !hasMeaningfulLabel) {
      skippedDepths.push(depth);
      continue;
    }
    const adjustedDepth = Math.max(0, depth - skippedDepths.length);
    result.push({ ...node, depth: adjustedDepth });
  }
  return result;
}
