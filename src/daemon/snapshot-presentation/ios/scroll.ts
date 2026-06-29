import type { RawSnapshotNode } from '../../../kernel/snapshot.ts';
import {
  inferVerticalScrollIndicatorDirections,
  isSystemScrollIndicatorLabel,
} from '../../../utils/scroll-indicator.ts';
import {
  findNearestScrollableContainer,
  isScrollableSnapshotType,
  mergeReplacement,
  type SnapshotTreeRuleContext,
} from '../tree.ts';

export function collectIosScrollIndicatorPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  for (const node of nodes) {
    if (!isIosScrollIndicatorNode(node)) {
      continue;
    }
    collectIosScrollIndicatorNodePresentation(node, byIndex, context);
  }
}

function isIosScrollIndicatorNode(node: RawSnapshotNode): boolean {
  const label = node.label?.trim();
  return Boolean(label && isSystemScrollIndicatorLabel(label));
}

function collectIosScrollIndicatorNodePresentation(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
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
  mergeReplacement(context.replacements, container, {
    rect: deriveScrollableViewportRect(container.rect, indicator.rect) ?? container.rect,
    hiddenContentAbove: mergeHiddenContentFlag(container.hiddenContentAbove, directions.above),
    hiddenContentBelow: mergeHiddenContentFlag(container.hiddenContentBelow, directions.below),
  });
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
