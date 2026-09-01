import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { findDescendant, forEachDescendant, type SnapshotTreeRuleContext } from './tree.ts';

export function collectIosSearchToolbarSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    if (!node) continue;
    if (isExposedSearchField(node)) {
      suppressSearchToolbarDescendants(nodes, position, node, context);
      continue;
    }
    if (!isSearchToolbar(node)) continue;

    const innerSearch = findDescendant(
      nodes,
      position,
      (candidate) =>
        normalizeType(candidate.type ?? '') === 'searchfield' && candidate.label === 'Search',
    );
    if (!innerSearch) {
      continue;
    }

    context.suppressNode(node, [innerSearch]);
    suppressToolbarAncestors(node, innerSearch, context);
    suppressSearchToolbarDescendants(nodes, position, innerSearch, context);
  }
}

function isExposedSearchField(node: RawSnapshotNode): boolean {
  return normalizeType(node.type ?? '') === 'searchfield' && node.label === 'Search';
}

function isSearchToolbar(node: RawSnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return node.label === 'Toolbar' && (type === 'toolbar' || type === 'searchfield');
}

function suppressSearchToolbarDescendants(
  nodes: RawSnapshotNode[],
  position: number,
  keptSearch: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
): void {
  forEachDescendant(nodes, position, (descendant) => {
    if (descendant.index === keptSearch.index) {
      return;
    }
    if (shouldSuppressIosSearchToolbarDescendant(descendant)) {
      context.suppressNode(descendant, [keptSearch]);
    }
  });
}

function suppressToolbarAncestors(
  node: RawSnapshotNode,
  representative: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
): void {
  let current = node;
  while (typeof current.parentIndex === 'number') {
    const parent = context.sourceNodesByIndex.get(current.parentIndex);
    if (!parent || parent.label !== 'Toolbar') {
      return;
    }
    context.suppressNode(parent, [representative]);
    current = parent;
  }
}

function shouldSuppressIosSearchToolbarDescendant(node: RawSnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  if (type === 'button') {
    return false;
  }
  if (type === 'image') {
    return true;
  }
  return node.label === 'Search';
}
