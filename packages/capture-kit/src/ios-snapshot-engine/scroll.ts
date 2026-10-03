import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import {
  inferVerticalScrollIndicatorDirections,
  isSystemScrollIndicatorLabel,
} from '@agent-device/kernel/scroll-indicator';
import {
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
 * children of that view, so the indicator's parent edge is the producer's own claim of ownership and
 * a band derives only when that parent is itself a scroll type. Reading the parent rather than
 * walking ancestors is what keeps a scroll-shaped host that publishes as a non-scroll type — a
 * `UITextView` row (#2214, patched for that one type by #2740), a `WKWebView`, a map view, a paged
 * cell — from misattributing its indicator to the enclosing list and clipping the list to one line of
 * the host. An indicator whose parent is not a scroll type owns nothing (ADR 0026).
 *
 * A node that is itself a scroll type and carries an indicator label describes itself, not its
 * parent, so it owns nothing too: banding its parent would clip a sibling list to the host's band —
 * the same over-clip as #2214, mirrored upward.
 */
function scrollIndicatorParent(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | undefined {
  return typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
}

function occupiesSameFrame(node: RawSnapshotNode, ancestor: RawSnapshotNode): boolean {
  return node.rect != null && ancestor.rect != null && rectsEqual(node.rect, ancestor.rect);
}

// Ownership follows the parent edge, but a scroll region can be wrapped by transparent ancestors that
// fill it exactly — Safari nests `Other` → `WebView` → `WebView` above a `WKWebView`'s `ScrollView`, all
// one frame. The walk climbs only through such same-frame ancestors and stops at the first frame change,
// so a host smaller than its list (a `WebView` row) is a separate region and owns nothing (ADR 0026).
function findScrollIndicatorContainer(
  node: RawSnapshotNode,
  byIndex: ReadonlyMap<number, RawSnapshotNode>,
): RawSnapshotNode | null {
  if (isScrollableSnapshotType(node.type)) return null;
  let current = scrollIndicatorParent(node, byIndex);
  while (current && !isScrollableSnapshotType(current.type)) {
    const parent = scrollIndicatorParent(current, byIndex);
    if (!parent || !occupiesSameFrame(current, parent)) return null;
    current = parent;
  }
  return current ?? null;
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
