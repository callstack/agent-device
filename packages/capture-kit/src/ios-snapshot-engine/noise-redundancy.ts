import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import {
  areRectsApproximatelyEqual,
  findDescendant,
  forEachDescendant,
  isRepeatedStaticNode,
  isScrollableSnapshotType,
  isSemanticActionNode,
  type SnapshotTreeRuleContext,
} from './tree.ts';
import { forEachOtherNodeWithLabel } from './noise-helpers.ts';

export function collectIosRepeatedStaticSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    const nodeLabel = node?.label?.trim();
    if (!node || context.isSuppressed(node) || !nodeLabel) {
      continue;
    }

    collectRepeatedStaticSuppressionForNode(nodes, position, node, nodeLabel, context);
  }
}

function collectRepeatedStaticSuppressionForNode(
  nodes: RawSnapshotNode[],
  position: number,
  node: RawSnapshotNode,
  nodeLabel: string,
  context: SnapshotTreeRuleContext,
): void {
  const type = normalizeType(node.type ?? '');
  if (type === 'statictext' || type === 'link') {
    suppressRepeatedStaticDescendants(nodes, position, nodeLabel, node, context);
    return;
  }
  if (type !== 'other') {
    return;
  }
  const semanticDescendant = findEquivalentSemanticDescendant(nodes, position, nodeLabel);
  if (semanticDescendant) {
    context.suppressNode(node, [semanticDescendant]);
    return;
  }
  suppressRepeatedStaticDescendants(nodes, position, nodeLabel, node, context);
}

function findEquivalentSemanticDescendant(
  nodes: RawSnapshotNode[],
  position: number,
  nodeLabel: string,
): RawSnapshotNode | undefined {
  return findDescendant(nodes, position, (descendant) => {
    const type = normalizeType(descendant.type ?? '');
    return (
      (type === 'link' || type === 'searchfield' || isScrollableSnapshotType(descendant.type)) &&
      descendant.label?.trim() === nodeLabel
    );
  });
}

function suppressRepeatedStaticDescendants(
  nodes: RawSnapshotNode[],
  position: number,
  label: string,
  representative: RawSnapshotNode,
  context: SnapshotTreeRuleContext,
): void {
  forEachDescendant(nodes, position, (descendant) => {
    if (
      !context.semanticRepresentativeIndexes.has(descendant.index) &&
      isRepeatedStaticNode(descendant, label)
    ) {
      context.suppressNode(descendant, [representative]);
    }
  });
}

export function collectIosActionWrapperSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  forEachOtherNodeWithLabel(nodes, (node, nodeLabel, position) => {
    const semanticDescendant = findDescendant(nodes, position, (descendant) => {
      return (
        isSemanticActionNode(descendant) &&
        descendant.label?.trim() === nodeLabel &&
        (areRectsApproximatelyEqual(descendant.rect, node.rect) ||
          isIosBackdropDismissWrapper(node, descendant))
      );
    });
    if (semanticDescendant) {
      context.suppressNode(node, [semanticDescendant]);
    }
  });
}

function isIosBackdropDismissWrapper(node: RawSnapshotNode, descendant: RawSnapshotNode): boolean {
  if (descendant.label?.trim() !== node.label?.trim()) {
    return false;
  }
  const descendantType = normalizeType(descendant.type ?? '');
  return (
    isNamedButtonBackdrop(node, descendantType) ||
    descendantType === 'textfield' ||
    isFullscreenActionLabelWrapper(node, descendantType, descendant)
  );
}

function isNamedButtonBackdrop(node: RawSnapshotNode, descendantType: string): boolean {
  const label = node.label?.trim();
  return descendantType === 'button' && (label === 'Dismiss' || label === 'Back');
}

function isFullscreenActionLabelWrapper(
  node: RawSnapshotNode,
  descendantType: string,
  descendant: RawSnapshotNode,
): boolean {
  if (descendantType !== 'button') {
    return false;
  }
  if (!node.rect || !descendant.rect) {
    return false;
  }
  return (
    node.rect.x === 0 &&
    node.rect.y === 0 &&
    node.rect.width >= 300 &&
    node.rect.height >= 600 &&
    descendant.rect.width < node.rect.width
  );
}
