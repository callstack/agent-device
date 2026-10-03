import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import {
  findLargestViewportRect,
  forEachDescendant,
  type SnapshotTreeRuleContext,
} from './tree.ts';

export function collectIosOffscreenKeyboardSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const viewport = findLargestViewportRect(nodes);
  const screenBottom = viewport ? viewport.y + viewport.height : null;
  if (screenBottom === null) {
    return;
  }
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    if (!node || !isOffscreenKeyboardNode(node, screenBottom)) {
      continue;
    }
    context.suppressNode(node, []);
    suppressOffscreenKeyboardAncestors(node, context, screenBottom);
    forEachDescendant(nodes, position, (descendant) => {
      context.suppressNode(descendant, []);
    });
  }
}

function isOffscreenKeyboardNode(node: RawSnapshotNode, screenBottom: number): boolean {
  if (!node.rect || normalizeType(node.type ?? '') !== 'keyboard') {
    return false;
  }
  return node.rect.y >= screenBottom;
}

function suppressOffscreenKeyboardAncestors(
  node: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
  screenBottom: number,
): void {
  let current =
    typeof node.parentIndex === 'number'
      ? context.sourceNodesByIndex.get(node.parentIndex)
      : undefined;
  while (current?.rect && current.rect.y >= screenBottom) {
    context.suppressNode(current, []);
    current =
      typeof current.parentIndex === 'number'
        ? context.sourceNodesByIndex.get(current.parentIndex)
        : undefined;
  }
}
