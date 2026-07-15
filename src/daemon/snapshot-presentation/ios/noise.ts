import type { RawSnapshotNode } from '../../../kernel/snapshot.ts';
import { rectArea, rectContains } from '../../../kernel/rect.ts';
import {
  isReactNativeCollapsedWarningWrapperCandidate,
  isReactNativeCollapsedWarningWrapperWithVisibleBanner,
  isReactNativeOverlayDismissLabel,
  isReactNativeOverlayMinimizeLabel,
} from '../../../core/react-native-overlay.ts';
import { normalizeType } from '../../../snapshot/snapshot-processing.ts';
import { collectIosScrollIndicatorPresentation } from './scroll.ts';
import {
  areRectsApproximatelyEqual,
  findDescendant,
  findLargestViewportRect,
  forEachDescendant,
  isRepeatedStaticNode,
  isScrollableSnapshotType,
  isSemanticActionNode,
  mergeReplacement,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

export function collectIosPresentationNoiseSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const { suppressedIndexes } = context;
  collectIosOffscreenKeyboardSuppression(nodes, suppressedIndexes);
  collectIosStructuralIdentifierSuppression(nodes, suppressedIndexes);
  collectIosScrollIndicatorPresentation(nodes, context);
  collectIosSearchToolbarSuppression(nodes, suppressedIndexes);
  collectIosActionWrapperSuppression(nodes, suppressedIndexes);
  collectIosReactNativeOverlayActionPresentation(nodes, context.replacements);
  collectIosReactNativeOverlayWrapperSuppression(nodes, suppressedIndexes);
  collectIosRepeatedStaticSuppression(nodes, suppressedIndexes);
}

function collectIosReactNativeOverlayActionPresentation(
  nodes: RawSnapshotNode[],
  replacements: Map<number, RawSnapshotNode>,
): void {
  forEachOtherNodeWithLabel(nodes, (node, nodeLabel, position) => {
    if (!isReactNativeOverlayDismissLabel(nodeLabel) || !node.rect) return;
    const minimize = findDescendant(
      nodes,
      position,
      (descendant) =>
        Boolean(descendant.rect) &&
        isReactNativeOverlayMinimizeLabel(descendant.label?.trim() ?? ''),
    );
    if (!minimize?.rect) return;
    const dismissRect = remainingHorizontalPartition(node.rect, minimize.rect);
    if (!dismissRect) return;
    const representativeRect = smallestContainedDismissRect(nodes, position, dismissRect);
    mergeReplacement(replacements, node, { rect: representativeRect });
    forEachDescendant(nodes, position, (descendant) => {
      if (isReactNativeOverlayDismissLabel(descendant.label?.trim() ?? '')) {
        mergeReplacement(replacements, descendant, { rect: representativeRect });
      }
    });
  });
}

function smallestContainedDismissRect(
  nodes: RawSnapshotNode[],
  position: number,
  partition: NonNullable<RawSnapshotNode['rect']>,
): NonNullable<RawSnapshotNode['rect']> {
  let representative = partition;
  forEachDescendant(nodes, position, (descendant) => {
    const label = descendant.label?.trim() ?? '';
    if (!descendant.rect || !isReactNativeOverlayDismissLabel(label)) return;
    if (!rectContains(partition, descendant.rect)) return;
    if (rectArea(descendant.rect) < rectArea(representative)) {
      representative = descendant.rect;
    }
  });
  return representative;
}

function remainingHorizontalPartition(
  wrapper: NonNullable<RawSnapshotNode['rect']>,
  occupied: NonNullable<RawSnapshotNode['rect']>,
): NonNullable<RawSnapshotNode['rect']> | undefined {
  const wrapperRight = wrapper.x + wrapper.width;
  const occupiedRight = occupied.x + occupied.width;
  const expectedRightPartition = {
    x: occupied.x,
    y: wrapper.y,
    width: wrapperRight - occupied.x,
    height: wrapper.height,
  };
  if (occupied.x > wrapper.x && areRectsApproximatelyEqual(occupied, expectedRightPartition)) {
    return { ...wrapper, width: occupied.x - wrapper.x };
  }
  const expectedLeftPartition = {
    x: wrapper.x,
    y: wrapper.y,
    width: occupiedRight - wrapper.x,
    height: wrapper.height,
  };
  if (occupiedRight < wrapperRight && areRectsApproximatelyEqual(occupied, expectedLeftPartition)) {
    return { ...wrapper, x: occupiedRight, width: wrapperRight - occupiedRight };
  }
  return undefined;
}

function collectIosReactNativeOverlayWrapperSuppression(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
): void {
  forEachOtherNodeWithLabel(nodes, (node, _nodeLabel, position) => {
    if (!isReactNativeCollapsedWarningWrapperCandidate(node)) return;
    if (
      isReactNativeCollapsedWarningWrapperWithVisibleBanner(
        node,
        collectDescendantNodes(nodes, position),
      )
    ) {
      suppressedIndexes.add(node.index);
    }
  });
}

function collectDescendantNodes(nodes: RawSnapshotNode[], position: number): RawSnapshotNode[] {
  const descendants: RawSnapshotNode[] = [];
  forEachDescendant(nodes, position, (descendant) => {
    descendants.push(descendant);
  });
  return descendants;
}

function collectIosRepeatedStaticSuppression(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
): void {
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    const nodeLabel = node?.label?.trim();
    if (!node || suppressedIndexes.has(node.index) || !nodeLabel) {
      continue;
    }

    collectRepeatedStaticSuppressionForNode(nodes, position, node, nodeLabel, suppressedIndexes);
  }
}

function collectRepeatedStaticSuppressionForNode(
  nodes: RawSnapshotNode[],
  position: number,
  node: RawSnapshotNode,
  nodeLabel: string,
  suppressedIndexes: Set<number>,
): void {
  const type = normalizeType(node.type ?? '');
  if (type === 'statictext' || type === 'link') {
    suppressRepeatedStaticDescendants(nodes, position, nodeLabel, suppressedIndexes);
    return;
  }
  if (type !== 'other') {
    return;
  }
  if (hasEquivalentSemanticDescendant(nodes, position, nodeLabel)) {
    suppressedIndexes.add(node.index);
    return;
  }
  suppressRepeatedStaticDescendants(nodes, position, nodeLabel, suppressedIndexes);
}

function hasEquivalentSemanticDescendant(
  nodes: RawSnapshotNode[],
  position: number,
  nodeLabel: string,
): boolean {
  return Boolean(
    findDescendant(nodes, position, (descendant) => {
      const type = normalizeType(descendant.type ?? '');
      return (
        (type === 'link' || type === 'searchfield' || isScrollableSnapshotType(descendant.type)) &&
        descendant.label?.trim() === nodeLabel
      );
    }),
  );
}

function suppressRepeatedStaticDescendants(
  nodes: RawSnapshotNode[],
  position: number,
  label: string,
  suppressedIndexes: Set<number>,
): void {
  forEachDescendant(nodes, position, (descendant) => {
    if (isRepeatedStaticNode(descendant, label)) {
      suppressedIndexes.add(descendant.index);
    }
  });
}

function collectIosActionWrapperSuppression(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
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
      suppressedIndexes.add(node.index);
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

function collectIosOffscreenKeyboardSuppression(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
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
    suppressedIndexes.add(node.index);
    suppressOffscreenKeyboardAncestors(node, nodes, suppressedIndexes, screenBottom);
    forEachDescendant(nodes, position, (descendant) => {
      suppressedIndexes.add(descendant.index);
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
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
  screenBottom: number,
): void {
  const byIndex = new Map(nodes.map((candidate) => [candidate.index, candidate]));
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  while (current?.rect && current.rect.y >= screenBottom) {
    suppressedIndexes.add(current.index);
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
}

function collectIosStructuralIdentifierSuppression(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
): void {
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
    suppressedIndexes.add(node.index);
  }
}

function collectIosSearchToolbarSuppression(
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
): void {
  for (let position = 0; position < nodes.length; position += 1) {
    const node = nodes[position];
    if (!node || normalizeType(node.type ?? '') !== 'searchfield') {
      continue;
    }
    if (node.label === 'Search') {
      suppressSearchToolbarDescendants(nodes, position, null, suppressedIndexes);
      continue;
    }
    if (node.label !== 'Toolbar') {
      continue;
    }
    const innerSearch = findDescendant(
      nodes,
      position,
      (candidate) =>
        normalizeType(candidate.type ?? '') === 'searchfield' && candidate.label === 'Search',
    );
    if (!innerSearch) {
      continue;
    }

    suppressedIndexes.add(node.index);
    suppressToolbarAncestors(node, nodes, suppressedIndexes);
    suppressSearchToolbarDescendants(nodes, position, innerSearch.index, suppressedIndexes);
  }
}

function suppressSearchToolbarDescendants(
  nodes: RawSnapshotNode[],
  position: number,
  keptSearchIndex: number | null,
  suppressedIndexes: Set<number>,
): void {
  forEachDescendant(nodes, position, (descendant) => {
    if (descendant.index === keptSearchIndex) {
      return;
    }
    if (shouldSuppressIosSearchToolbarDescendant(descendant)) {
      suppressedIndexes.add(descendant.index);
    }
  });
}

function suppressToolbarAncestors(
  node: RawSnapshotNode,
  nodes: RawSnapshotNode[],
  suppressedIndexes: Set<number>,
): void {
  const byIndex = new Map(nodes.map((candidate) => [candidate.index, candidate]));
  let current = node;
  while (typeof current.parentIndex === 'number') {
    const parent = byIndex.get(current.parentIndex);
    if (!parent || parent.label !== 'Toolbar') {
      return;
    }
    suppressedIndexes.add(parent.index);
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

function forEachOtherNodeWithLabel(
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
