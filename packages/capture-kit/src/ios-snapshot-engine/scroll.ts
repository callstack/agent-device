import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import {
  inferVerticalScrollIndicatorDirections,
  isSystemScrollIndicatorLabel,
} from '@agent-device/kernel/scroll-indicator';
import { normalizeType } from '@agent-device/contracts/snapshot';
import {
  findNearestAncestor,
  isScrollableSnapshotType,
  mergeReplacement,
  updateReplacement,
  type SnapshotTreeRuleContext,
} from './tree.ts';

export function collectIosScrollIndicatorPresentation(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
): void {
  const derivedScrollContainerIndexes = new Set<number>();
  for (const node of nodes) {
    const presentedNode = context.replacements.get(node.index) ?? node;
    if (!isIosScrollIndicatorNode(presentedNode)) {
      continue;
    }
    collectIosScrollIndicatorNodePresentation(
      node,
      context.sourceNodesByIndex,
      context,
      derivedScrollContainerIndexes,
    );
  }
  clipDescendantsToDerivedScrollViewports(nodes, context, derivedScrollContainerIndexes);
}

function isIosScrollIndicatorNode(node: RawSnapshotNode): boolean {
  const label = node.label?.trim();
  return Boolean(label && isSystemScrollIndicatorLabel(label));
}

function collectIosScrollIndicatorNodePresentation(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
  context: SnapshotTreeRuleContext,
  derivedScrollContainerIndexes: Set<number>,
): void {
  const suppressed = !isScrollableSnapshotType(node.type) || context.isSuppressed(node);
  const directions = inferVerticalScrollIndicatorDirections(node.label?.trim() ?? '', node.value);
  const container = directions ? findScrollIndicatorContainer(node, byIndex) : undefined;
  if (suppressed) context.suppressNode(node, container ? [container] : []);
  if (
    container &&
    directions &&
    applyScrollIndicatorReplacement(context, container, node, directions)
  ) {
    derivedScrollContainerIndexes.add(container.index);
  }
}

/**
 * The scroll container an indicator reports on. XCTest publishes a UIScrollView's indicators as
 * children of that view, so the nearest scroll-typed ancestor is normally the owner. A UITextView
 * is a UIScrollView too but publishes as `TextView`, and its indicators sit inside the text: read
 * onto the list around it, they clip that list to one line of text and drop every row after it
 * (a post thread whose root post is selectable text lost all of its replies). An indicator whose
 * nearest scrolling ancestor is a text view belongs to that text view, which derives no viewport,
 * so it resolves no container.
 */
function findScrollIndicatorContainer(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | null {
  if (isScrollableSnapshotType(node.type)) return node;
  const host = findNearestAncestor(
    node,
    byIndex,
    (ancestor) => isScrollableSnapshotType(ancestor.type) || isTextViewType(ancestor.type),
  );
  return host && isScrollableSnapshotType(host.type) ? host : null;
}

function isTextViewType(type: string | undefined): boolean {
  return normalizeType(type ?? '') === 'textview';
}

function clipDescendantsToDerivedScrollViewports(
  nodes: RawSnapshotNode[],
  context: SnapshotTreeRuleContext,
  derivedScrollContainerIndexes: ReadonlySet<number>,
): void {
  const states = new Map<number, DerivedViewportState>();
  for (const node of nodes) {
    const parentState = states.get(node.parentIndex ?? -1);
    const ancestorClip = parentState?.clip;
    const current = context.replacements.get(node.index) ?? node;
    const effectiveRect = intersectRect(current.rect, ancestorClip);
    const fullyClipped = isFullyClipped(current, ancestorClip, effectiveRect);
    const projectedOut = projectNodeOut(parentState, fullyClipped, current);
    applyViewportClip(
      context,
      node,
      current,
      ancestorClip,
      effectiveRect,
      fullyClipped,
      projectedOut,
    );
    states.set(
      node.index,
      buildDerivedViewportState(
        node,
        current,
        ancestorClip,
        effectiveRect,
        projectedOut,
        derivedScrollContainerIndexes,
      ),
    );
  }
}

type DerivedViewportState = Readonly<{ clip?: Rect; projectedOut: boolean }>;

function isFullyClipped(
  node: RawSnapshotNode,
  ancestorClip: Rect | undefined,
  effectiveRect: Rect | undefined,
): boolean {
  return Boolean(
    ancestorClip && isPositiveFiniteRect(node.rect) && !isPositiveFiniteRect(effectiveRect),
  );
}

function projectNodeOut(
  parentState: DerivedViewportState | undefined,
  fullyClipped: boolean,
  node: RawSnapshotNode,
): boolean {
  return Boolean(parentState?.projectedOut || (fullyClipped && ownsDescendants(node)));
}

function applyViewportClip(
  context: SnapshotTreeRuleContext,
  node: RawSnapshotNode,
  current: RawSnapshotNode,
  ancestorClip: Rect | undefined,
  effectiveRect: Rect | undefined,
  fullyClipped: boolean,
  projectedOut: boolean,
): void {
  if (projectedOut || fullyClipped) {
    context.suppressNode(node, []);
  } else if (ancestorClip && effectiveRect && !rectsEqual(current.rect, effectiveRect)) {
    mergeReplacement(context.replacements, node, { rect: effectiveRect });
  }
}

function buildDerivedViewportState(
  node: RawSnapshotNode,
  current: RawSnapshotNode,
  ancestorClip: Rect | undefined,
  effectiveRect: Rect | undefined,
  projectedOut: boolean,
  derivedScrollContainerIndexes: ReadonlySet<number>,
): DerivedViewportState {
  const establishesClip = canEstablishDerivedClip(
    node,
    current,
    ancestorClip,
    effectiveRect,
    derivedScrollContainerIndexes,
  );
  return {
    projectedOut,
    ...(establishesClip ? { clip: effectiveRect } : ancestorClip ? { clip: ancestorClip } : {}),
  };
}

function canEstablishDerivedClip(
  node: RawSnapshotNode,
  current: RawSnapshotNode,
  ancestorClip: Rect | undefined,
  effectiveRect: Rect | undefined,
  derivedScrollContainerIndexes: ReadonlySet<number>,
): boolean {
  return Boolean(
    isPositiveFiniteRect(effectiveRect) &&
    (derivedScrollContainerIndexes.has(node.index) ||
      (ancestorClip !== undefined && isScrollableSnapshotType(current.type))),
  );
}

function ownsDescendants(node: RawSnapshotNode): boolean {
  return node.type?.trim().toLowerCase() === 'cell' || isScrollableSnapshotType(node.type);
}

function intersectRect(rect: RawSnapshotNode['rect'], clip: Rect | undefined): Rect | undefined {
  if (!rect || !clip) return rect;
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function rectsEqual(left: RawSnapshotNode['rect'], right: Rect): boolean {
  return Boolean(
    left &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height,
  );
}

function applyScrollIndicatorReplacement(
  context: SnapshotTreeRuleContext,
  container: RawSnapshotNode,
  indicator: RawSnapshotNode,
  directions: { above: boolean; below: boolean },
): boolean {
  const derivedRect = deriveScrollableViewportRect(
    (context.replacements.get(container.index) ?? container).rect,
    indicator.rect,
  );
  updateReplacement(context.replacements, container, (current) => ({
    rect: derivedRect ?? current.rect,
    hiddenContentAbove: mergeHiddenContentFlag(current.hiddenContentAbove, directions.above),
    hiddenContentBelow: mergeHiddenContentFlag(current.hiddenContentBelow, directions.below),
  }));
  return Boolean(derivedRect);
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
