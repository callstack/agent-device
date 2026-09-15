import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { collectChildrenByParent, type SnapshotTreeRuleContext } from './tree.ts';

export function collectIosStructuralIdentifierSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const childrenByParent = collectChildrenByParent(nodes);
  for (const node of nodes) {
    if (normalizeType(node.type ?? '') !== 'other') {
      continue;
    }
    if (node.hittable === true || node.label?.trim() || node.value?.trim()) {
      continue;
    }
    if (!node.identifier?.trim()) {
      continue;
    }
    const content = collectSubtreeByParentLinks(node, childrenByParent);
    // Suppression delegates the identifier to the wrapper's content. With no content there is
    // nothing to delegate to, and only the node's own declared `hittable: false` says the wrapper
    // is inert; a producer that reports no hittability at all declares nothing (#2638).
    if (content.length === 0 && node.hittable !== false) {
      continue;
    }
    context.suppressNode(node, content);
  }
}

function collectSubtreeByParentLinks(
  root: RawSnapshotNode,
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
): RawSnapshotNode[] {
  const descendants: RawSnapshotNode[] = [];
  const visited = new Set<number>([root.index]);
  const pending = [...(childrenByParent.get(root.index) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current.index)) continue;
    visited.add(current.index);
    descendants.push(current);
    const children = childrenByParent.get(current.index);
    if (children) pending.push(...children);
  }
  return descendants;
}
