import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { rectArea, rectContains } from '@agent-device/kernel/rect';
import {
  isReactNativeCollapsedWarningWrapperCandidate,
  isReactNativeCollapsedWarningWrapperWithVisibleBanner,
  isReactNativeOverlayDismissLabel,
  isReactNativeOverlayMinimizeLabel,
} from '@agent-device/contracts/react-native-overlay';
import {
  areRectsApproximatelyEqual,
  findDescendant,
  forEachDescendant,
  mergeReplacement,
  type SnapshotTreeRuleContext,
} from './tree.ts';
import { forEachOtherNodeWithLabel } from './noise-helpers.ts';

export function collectIosReactNativeOverlayActionPresentation(
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

export function collectIosReactNativeOverlayWrapperSuppression(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  forEachOtherNodeWithLabel(nodes, (node, _nodeLabel, position) => {
    if (!isReactNativeCollapsedWarningWrapperCandidate(node)) return;
    if (
      isReactNativeCollapsedWarningWrapperWithVisibleBanner(
        node,
        collectDescendantNodes(nodes, position),
      )
    ) {
      context.suppressNode(node, collectDescendantNodes(nodes, position));
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
