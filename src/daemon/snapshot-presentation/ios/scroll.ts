import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  inferVerticalScrollIndicatorDirections,
  isSystemScrollIndicatorLabel,
} from '../../../utils/scroll-indicator.ts';
import {
  findNearestScrollableContainer,
  isScrollableSnapshotType,
  updateReplacement,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

export function collectIosScrollIndicatorPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  for (const node of nodes) {
    const presentedNode = context.replacements.get(node.index) ?? node;
    if (!isIosScrollIndicatorNode(presentedNode)) {
      continue;
    }
    collectIosScrollIndicatorNodePresentation(node, context.sourceNodesByIndex, context);
  }
}

function isIosScrollIndicatorNode(node: RawSnapshotNode): boolean {
  const label = node.label?.trim();
  return Boolean(label && isSystemScrollIndicatorLabel(label));
}

function collectIosScrollIndicatorNodePresentation(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
  context: SnapshotTreeRuleContext,
): void {
  if (!isScrollableSnapshotType(node.type)) {
    context.suppressedIndexes.add(node.index);
  }

  const directions = inferVerticalScrollIndicatorDirections(node.label?.trim() ?? '', node.value);
  if (!directions) {
    return;
  }

  const container = findNearestScrollableContainer(node, byIndex, { includeSelf: true });
  if (!container) {
    return;
  }

  applyScrollIndicatorReplacement(context, container, node, directions);
}

function applyScrollIndicatorReplacement(
  context: SnapshotTreeRuleContext,
  container: RawSnapshotNode,
  indicator: RawSnapshotNode,
  directions: { above: boolean; below: boolean },
): void {
  updateReplacement(context.replacements, container, (current) => ({
    rect: deriveScrollableViewportRect(current.rect, indicator.rect) ?? current.rect,
    hiddenContentAbove: mergeHiddenContentFlag(current.hiddenContentAbove, directions.above),
    hiddenContentBelow: mergeHiddenContentFlag(current.hiddenContentBelow, directions.below),
  }));
}

function mergeHiddenContentFlag(
  existing: boolean | undefined,
  inferred: boolean,
): true | undefined {
  return existing === true || inferred ? true : undefined;
}

function deriveScrollableViewportRect(
  containerRect: RawSnapshotNode['rect'],
  indicatorRect: RawSnapshotNode['rect'],
): RawSnapshotNode['rect'] | undefined {
  if (!containerRect || !indicatorRect) {
    return undefined;
  }
  if (indicatorRect.height <= 0 || indicatorRect.height >= containerRect.height) {
    return undefined;
  }
  if (
    indicatorRect.y < containerRect.y ||
    indicatorRect.y > containerRect.y + containerRect.height
  ) {
    return undefined;
  }
  return {
    ...containerRect,
    y: indicatorRect.y,
    height: Math.min(
      indicatorRect.height,
      containerRect.y + containerRect.height - indicatorRect.y,
    ),
  };
}
