import type { RawSnapshotNode, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { centerOfRect } from '@agent-device/kernel/snapshot';
import {
  containsPoint,
  isPositiveFiniteRect,
  isRectVisibleInViewport,
  pickLargestRect,
} from '@agent-device/kernel/rect';
import { isScrollableNodeLike } from './snapshot-scroll.ts';
import { normalizeType } from './snapshot-text.ts';
import { buildSnapshotNodeMap, findSnapshotAncestor } from './snapshot-tree.ts';

type SnapshotVisibilityNode = Pick<
  SnapshotNode,
  'rect' | 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'
>;

const snapshotVisibilityBrand: unique symbol = Symbol('SnapshotVisibility');

export type SnapshotVisibilityProbe = {
  readonly onNodeMapBuilt?: () => void;
  readonly onViewportRectsCollected?: () => void;
  readonly onContainingRectFallback?: () => void;
};

export type SnapshotVisibility = {
  readonly [snapshotVisibilityBrand]: true;
  readonly nodeByIndex: ReadonlyMap<number, SnapshotNode>;
  readonly viewportRects: readonly Rect[];
  findAncestor<T>(node: SnapshotNode, resolve: (ancestor: SnapshotNode) => T | null): T | null;
  isVisibleInEffectiveViewport(node: SnapshotVisibilityNode): boolean;
  isVisibleOnScreen(node: SnapshotVisibilityNode): boolean;
  resolveEffectiveViewport(node: SnapshotVisibilityNode): Rect | null;
  resolveViewport(targetRect: Rect): Rect | null;
};

export function createSnapshotVisibility(
  nodes: SnapshotNode[],
  probe: SnapshotVisibilityProbe = {},
): SnapshotVisibility {
  let nodeByIndex: ReadonlyMap<number, SnapshotNode> | undefined;
  let viewportRects: readonly Rect[] | undefined;
  const getNodeByIndex = (): ReadonlyMap<number, SnapshotNode> => {
    if (!nodeByIndex) {
      nodeByIndex = buildSnapshotNodeMap(nodes);
      probe.onNodeMapBuilt?.();
    }
    return nodeByIndex;
  };
  const getViewportRects = (): readonly Rect[] => {
    if (!viewportRects) {
      viewportRects = collectViewportRects(nodes);
      probe.onViewportRectsCollected?.();
    }
    return viewportRects;
  };
  const resolveViewport = (targetRect: Rect): Rect | null =>
    resolveViewportRectInternal(
      nodes,
      targetRect,
      getViewportRects(),
      probe.onContainingRectFallback,
    );
  const resolveEffectiveViewport = (node: SnapshotVisibilityNode): Rect | null => {
    const clippingAncestorRect = findNearestScrollableAncestor(node, getNodeByIndex(), (ancestor) =>
      Boolean(ancestor.rect),
    )?.rect;
    if (clippingAncestorRect) return clippingAncestorRect;
    const roots = getViewportRects();
    if (roots.length === 0) return null;
    return resolveViewportRectInternal(
      nodes,
      node.rect ?? { x: 0, y: 0, width: 0, height: 0 },
      roots,
      probe.onContainingRectFallback,
    );
  };
  const isVisibleInEffectiveViewport = (node: SnapshotVisibilityNode): boolean => {
    if (!node.rect) return true;
    const viewport = resolveEffectiveViewport(node);
    return !viewport || isRectVisibleInViewport(node.rect, viewport);
  };
  const isVisibleOnScreen = (node: SnapshotVisibilityNode): boolean => {
    if (!node.rect) return true;
    if (!isVisibleInEffectiveViewport(node)) return false;
    return isTapPointInsideViewport(node.rect, resolveViewport(node.rect));
  };

  return {
    [snapshotVisibilityBrand]: true,
    get nodeByIndex() {
      return getNodeByIndex();
    },
    get viewportRects() {
      return getViewportRects();
    },
    findAncestor(node, resolve) {
      return findSnapshotAncestor(nodes, node, getNodeByIndex(), resolve);
    },
    isVisibleInEffectiveViewport,
    isVisibleOnScreen,
    resolveEffectiveViewport,
    resolveViewport,
  };
}

/**
 * The application/window root: the node a target rect is measured against, and
 * the node whose own rect is invariant under any gesture.
 *
 * One definition for the whole repo. It reads `type`, `role` AND `subrole`
 * because the macOS helper is the only backend that populates the latter two,
 * and it is the only backend that can emit a window whose `type` does not say
 * so — `normalizedSnapshotType` returns the raw subrole for a non-standard
 * window, so an `AXWindow` with subrole `AXSystemDialog` or `AXUnknown` reads
 * as neither from `type` alone while `role` names it exactly.
 *
 * Substring, not equality: macOS emits unmapped roles with their `AX` prefix
 * intact and subroles like `AXFloatingWindow` that are windows by any reading.
 * iOS emits a closed set of 31 short names in which only `Application` and
 * `Window` contain either word, so substring and equality agree there. Android
 * emits fully-qualified Java class names and no root node at all, so no
 * spelling of this predicate matches anything on Android — see
 * `resolveViewportRect`'s third fallback, which is what Android actually uses.
 */
export function isViewportRootNode(node: Pick<SnapshotNode, 'type' | 'role' | 'subrole'>): boolean {
  const kind = [node.type, node.role, node.subrole]
    .map((value) => normalizeType(value ?? ''))
    .join(' ');
  return kind.includes('application') || kind.includes('window');
}

/**
 * The Application/Window rects a target's viewport resolves against — the
 * whole-tree scan `resolveViewportRect` does per call when no
 * `precomputedViewportRects` is given. A caller resolving visibility for
 * several nodes against the SAME tree (e.g. ranking ambiguous selector
 * candidates) should build this once and thread it through, so N candidates
 * share one pass instead of each paying its own (#1970).
 */
export function collectViewportRects(nodes: RawSnapshotNode[]): Rect[] {
  return nodes.flatMap((node) =>
    isViewportRootNode(node) && isPositiveFiniteRect(node.rect) ? [node.rect] : [],
  );
}

/**
 * The root viewport a target rect is measured against: the largest
 * Application/Window rect containing the target's center, falling back to the
 * largest such rect, then to the largest containing rect of any node.
 */
export function resolveViewportRect(
  nodes: RawSnapshotNode[],
  targetRect: Rect,
  precomputedViewportRects?: readonly Rect[],
): Rect | null {
  return resolveViewportRectInternal(
    nodes,
    targetRect,
    precomputedViewportRects ?? collectViewportRects(nodes),
  );
}

function resolveViewportRectInternal(
  nodes: RawSnapshotNode[],
  targetRect: Rect,
  viewportRects: readonly Rect[],
  onContainingRectFallback?: () => void,
): Rect | null {
  const targetCenter = centerOfRect(targetRect);
  const contains = (rect: Rect) => containsPoint(rect, targetCenter.x, targetCenter.y);
  const viewport =
    pickLargestRect(viewportRects.filter(contains)) ?? pickLargestRect(viewportRects);
  if (viewport) return viewport;

  onContainingRectFallback?.();
  return pickLargestRect(
    nodes.flatMap((node) => (hasValidRect(node.rect) && contains(node.rect) ? [node.rect] : [])),
  );
}

function hasValidRect(rect: Rect | undefined): rect is Rect {
  if (!rect) return false;
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height)
  );
}

// Effective-viewport visibility measures a node against its nearest scrollable
// ancestor, so items inside an off-screen container (e.g. a closed drawer's own
// ScrollView at negative x) still read as "visible" within that container.
// On-screen visibility additionally requires the node's CENTER — the point an
// interaction would tap — to sit inside the root Application/Window viewport.
// Edge overlap is not enough: a mostly-off-screen drawer container can graze the
// viewport by a fraction of a pixel while its center is far off-screen.
// Interaction guards and selector disambiguation use this stricter form;
// scroll-direction summaries keep the effective form.
// The tap-point rule shared with the iOS runner (ADR 0011 Layer 2): the tap
// point is the rect's exact CENTER; it is inside the viewport iff it lies
// within the frame, edges inclusive. A missing, empty, or invalid viewport
// fails open (allowed) — resolving the best available viewport is the
// caller's job, and the rule must not turn a missing frame into a refusal.
// The Swift twin and this function are checked against
// contracts/fixtures/tap-point-policy.json; change the rule only via that table.
export function isTapPointInsideViewport(rect: Rect, viewport: Rect | null): boolean {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return true;
  }
  return containsPoint(viewport, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

/** Finds the nearest scrollable ancestor that satisfies the optional predicate. */
export function findNearestScrollableAncestor(
  node: SnapshotVisibilityNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
  predicate: (node: SnapshotNode) => boolean = () => true,
): SnapshotNode | null {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    visited.add(current.index);
    if (predicate(current) && isScrollableNodeLike(current)) {
      return current;
    }
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return null;
}

/**
 * Whether a node's own geometry can be trusted as evidence of what is on
 * screen. Containers that report their full content frame rather than the
 * clipped on-screen geometry are excluded, so a closed drawer's rows cannot
 * vouch for a viewport they are scrolled out of.
 *
 * The platform split is real: Android reports `hittable` reliably enough to
 * require it alongside a usable rect, while an iOS node with either signal is
 * still worth anchoring on.
 *
 * Shared because two packages need the identical judgement — `@agent-device/selectors`
 * when evaluating `is visible`, and `@agent-device/maestro` when picking a
 * visibility anchor — and a copy in each is a copy that can drift.
 */
export function isUsefulVisibilityAnchor(
  node: Pick<SnapshotNode, 'rect' | 'type' | 'hittable' | 'visibleToUser'>,
  platform: string,
): boolean {
  if (platform === 'android' && node.visibleToUser === false) return false;
  const type = normalizeType(node.type ?? '');
  if (
    type.includes('application') ||
    type.includes('window') ||
    type.includes('scrollview') ||
    type.includes('tableview') ||
    type.includes('collectionview') ||
    type === 'table' ||
    type === 'list' ||
    type === 'listview'
  ) {
    return false;
  }
  return platform === 'android'
    ? node.hittable === true && isPositiveFiniteRect(node.rect)
    : node.hittable === true || isPositiveFiniteRect(node.rect);
}
