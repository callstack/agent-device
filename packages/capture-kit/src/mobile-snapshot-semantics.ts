import { isRectVisibleInViewport } from '@agent-device/kernel/rect';
import {
  buildSnapshotNodeMap,
  extractNodeText,
  findNearestScrollableAncestor,
  isNodeVisibleInEffectiveViewport,
  isTapPointInsideViewport,
  resolveEffectiveViewportRect,
  resolveViewportRect,
} from '@agent-device/contracts/snapshot';
import { inferVerticalScrollIndicatorDirections } from '@agent-device/kernel/scroll-indicator';
import type { HiddenContentHint, Rect, SnapshotNode } from '@agent-device/kernel/snapshot';

type Direction = 'above' | 'below';

export type MobileSnapshotPresentation = {
  nodes: SnapshotNode[];
  hiddenCount: number;
  summaryLines: string[];
};

export function buildMobileSnapshotPresentation(nodes: SnapshotNode[]): MobileSnapshotPresentation {
  if (nodes.length === 0) {
    return { nodes, hiddenCount: 0, summaryLines: [] };
  }

  const { byIndex, visibleNodeIndexes, offscreenNodes, hintedContainers } =
    analyzeMobileSnapshotVisibility(nodes);
  const presentedNodes =
    visibleNodeIndexes.size === 0
      ? nodes
      : nodes.filter((node) => visibleNodeIndexes.has(node.index));
  const presentedNodesWithHints = presentedNodes.map((node) =>
    applyDerivedHiddenContentHints(node, hintedContainers.directionsByContainer),
  );

  return {
    nodes: presentedNodesWithHints,
    hiddenCount: visibleNodeIndexes.size === 0 ? 0 : nodes.length - presentedNodes.length,
    summaryLines: buildOffscreenSummaryLines(
      offscreenNodes.filter(
        (node) =>
          !hintedContainers.coveredNodeIndexes.has(node.index) && isDiscoverableOffscreenNode(node),
      ),
      nodes,
      byIndex,
    ),
  };
}

export function deriveMobileSnapshotHiddenContentHints(
  nodes: SnapshotNode[],
): Map<number, HiddenContentHint> {
  if (nodes.length === 0) {
    return new Map();
  }

  const { hintedContainers } = analyzeMobileSnapshotVisibility(nodes);
  return toHiddenContentHints(hintedContainers.directionsByContainer);
}

function analyzeMobileSnapshotVisibility(nodes: SnapshotNode[]): {
  byIndex: Map<number, SnapshotNode>;
  visibleNodeIndexes: Set<number>;
  offscreenNodes: SnapshotNode[];
  hintedContainers: {
    directionsByContainer: Map<number, Set<Direction>>;
    coveredNodeIndexes: Set<number>;
  };
} {
  const byIndex = buildSnapshotNodeMap(nodes);
  const visibleNodeIndexes = new Set<number>();
  const offscreenNodes: SnapshotNode[] = [];

  for (const node of nodes) {
    if (isNodeVisibleInEffectiveViewport(node, nodes, byIndex)) {
      markNodeAndAncestorsVisible(node, visibleNodeIndexes, byIndex);
      continue;
    }
    offscreenNodes.push(node);
  }

  const hintedContainers = deriveContainerHints(nodes, offscreenNodes, visibleNodeIndexes, byIndex);
  return { byIndex, visibleNodeIndexes, offscreenNodes, hintedContainers };
}

/**
 * #1542: the pure geometry boundary the off-screen refusal double-check's
 * direct probe (`src/daemon/offscreen-target-probe.ts`) reduces its decision
 * to, once it has a fresh, tree-independent read of one element. A probe
 * confirms the element genuinely on-screen only when BOTH hold: XCTest's own
 * live hit-test says `hittable`, AND the tap point sits inside the root
 * viewport (`isTapPointInsideViewport`, above). Either signal alone is
 * insufficient — `hittable` with no viewport check could confirm an element
 * that is technically tappable but whose reported rect drifted outside the
 * app window; a viewport check with no `hittable` check could confirm an
 * element occluded or clipped in a way geometry alone can't see. Kept pure
 * (and separate from the network read) so it is unit-testable without a
 * runner mock.
 */
export function isConfirmedOnScreenProbe(
  probe: { rect: Rect; hittable: boolean },
  rootViewport: Rect | null,
): boolean {
  return probe.hittable && isTapPointInsideViewport(probe.rect, rootViewport);
}

/** The concrete `scroll <direction>` that brings an off-screen target into view. */
export type OffscreenScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * The direction to `scroll` so an off-screen interaction target comes into view.
 * Derived from the SAME two boundaries `isNodeVisibleOnScreen` rejects against,
 * so every rejected target yields a direction (#1366) — not just the subset a
 * rect-vs-one-viewport check catches:
 *
 *  1. The rect has no overlap with its effective (scroll-container) viewport —
 *     an item scrolled out of an on-screen list. Direction from the container.
 *  2. The rect still overlaps its container, but the tap-point CENTER is pushed
 *     outside the ROOT viewport — a child inside an off-screen drawer, or a row
 *     straddling the viewport edge whose center is past it. The rect-vs-effective
 *     -viewport form misses both; this reads the boundary that actually failed.
 *
 * Direction follows the reveal convention the CLI hints already use
 * (`cli-help.ts`): off-screen below -> scroll down, above -> up, horizontal
 * mirror; the axis with the largest center overshoot wins so a corner-off target
 * gets its dominant move. Returns null only when the node is on-screen.
 */
export function classifyOffscreenScrollDirection(
  node: Pick<SnapshotNode, 'rect' | 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'>,
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): OffscreenScrollDirection | null {
  if (!node.rect) {
    return null;
  }
  // Boundary 1: fully separated from the effective (scroll-container) viewport.
  const effectiveViewport = resolveEffectiveViewportRect(node, nodes, byIndex);
  if (effectiveViewport && !isRectVisibleInViewport(node.rect, effectiveViewport)) {
    const direction = directionOfCenterOutsideViewport(node.rect, effectiveViewport);
    if (direction) {
      return direction;
    }
  }
  // Boundary 2: tap-point center outside the root viewport (off-screen container
  // or an edge-straddling rect whose center is past the frame).
  const rootViewport = resolveViewportRect(nodes, node.rect);
  if (rootViewport && !isTapPointInsideViewport(node.rect, rootViewport)) {
    const direction = directionOfCenterOutsideViewport(node.rect, rootViewport);
    if (direction) {
      return direction;
    }
  }
  return null;
}

/**
 * The dominant edge the rect's tap-point center sits beyond, or null when the
 * center is within the viewport on both axes. Uses the same unrounded center as
 * `isTapPointInsideViewport` so the direction agrees with the rejection at the
 * pixel boundary.
 */
function directionOfCenterOutsideViewport(
  rect: Rect,
  viewport: Rect,
): OffscreenScrollDirection | null {
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const overshoots: Array<{ direction: OffscreenScrollDirection; amount: number }> = [
    { direction: 'down', amount: centerY - (viewport.y + viewport.height) },
    { direction: 'up', amount: viewport.y - centerY },
    { direction: 'right', amount: centerX - (viewport.x + viewport.width) },
    { direction: 'left', amount: viewport.x - centerX },
  ];
  let best: { direction: OffscreenScrollDirection; amount: number } | null = null;
  for (const candidate of overshoots) {
    if (candidate.amount > 0 && (!best || candidate.amount > best.amount)) {
      best = candidate;
    }
  }
  return best?.direction ?? null;
}

function deriveContainerHints(
  allNodes: SnapshotNode[],
  offscreenNodes: SnapshotNode[],
  visibleNodeIndexes: Set<number>,
  byIndex: Map<number, SnapshotNode>,
): {
  directionsByContainer: Map<number, Set<Direction>>;
  coveredNodeIndexes: Set<number>;
} {
  const directionsByContainer = new Map<number, Set<Direction>>();
  const geometryDirectionsByContainer = new Map<number, Set<Direction>>();
  const coveredNodeIndexes = new Set<number>();

  for (const node of offscreenNodes) {
    if (!node.rect) {
      continue;
    }
    const container = findNearestVisibleScrollableAncestor(node, visibleNodeIndexes, byIndex);
    if (!container?.rect) {
      continue;
    }
    const direction = classifyVerticalDirection(node.rect, container.rect);
    if (!direction) {
      continue;
    }
    const directions = directionsByContainer.get(container.index) ?? new Set<Direction>();
    directions.add(direction);
    directionsByContainer.set(container.index, directions);
    const geometryDirections =
      geometryDirectionsByContainer.get(container.index) ?? new Set<Direction>();
    geometryDirections.add(direction);
    geometryDirectionsByContainer.set(container.index, geometryDirections);
    coveredNodeIndexes.add(node.index);
  }

  mergeScrollIndicatorDirections(
    allNodes,
    visibleNodeIndexes,
    byIndex,
    directionsByContainer,
    geometryDirectionsByContainer,
  );

  return { directionsByContainer, coveredNodeIndexes };
}

function toHiddenContentHints(
  directionsByContainer: Map<number, Set<Direction>>,
): Map<number, HiddenContentHint> {
  const hints = new Map<number, HiddenContentHint>();
  for (const [index, directions] of directionsByContainer) {
    const hint: HiddenContentHint = {};
    if (directions.has('above')) {
      hint.hiddenContentAbove = true;
    }
    if (directions.has('below')) {
      hint.hiddenContentBelow = true;
    }
    if (hint.hiddenContentAbove || hint.hiddenContentBelow) {
      hints.set(index, hint);
    }
  }
  return hints;
}

function applyDerivedHiddenContentHints(
  node: SnapshotNode,
  directionsByContainer: Map<number, Set<Direction>>,
): SnapshotNode {
  const directions = directionsByContainer.get(node.index);
  if (!directions || directions.size === 0) {
    return node;
  }
  const hiddenContentAbove =
    node.hiddenContentAbove === true || directions.has('above') ? true : undefined;
  const hiddenContentBelow =
    node.hiddenContentBelow === true || directions.has('below') ? true : undefined;
  return {
    ...node,
    hiddenContentAbove,
    hiddenContentBelow,
  };
}

function buildOffscreenSummaryLines(
  nodes: SnapshotNode[],
  snapshotNodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
): string[] {
  const groups = new Map<Direction, SnapshotNode[]>();
  for (const node of nodes) {
    const direction = classifyNodeDirection(node, snapshotNodes, byIndex);
    if (!direction) {
      continue;
    }
    const group = groups.get(direction) ?? [];
    group.push(node);
    groups.set(direction, group);
  }

  return (['above', 'below'] as Direction[]).flatMap((direction) => {
    const group = groups.get(direction);
    if (!group || group.length === 0) {
      return [];
    }
    const labels = uniqueLabels(group)
      .slice(0, 3)
      .map((label) => `"${label}"`);
    const noun = group.length === 1 ? 'interactive item' : 'interactive items';
    const suffix = labels.length > 0 ? `: ${labels.join(', ')}` : '';
    return [`[off-screen ${direction}] ${group.length} ${noun}${suffix}`];
  });
}

function classifyNodeDirection(
  node: SnapshotNode,
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode>,
): Direction | null {
  if (!node.rect) {
    return null;
  }
  const viewport = resolveEffectiveViewportRect(node, nodes, byIndex);
  if (!viewport) {
    return null;
  }
  return classifyVerticalDirection(node.rect, viewport);
}

function classifyVerticalDirection(targetRect: Rect, viewportRect: Rect): Direction | null {
  if (targetRect.y + targetRect.height <= viewportRect.y) {
    return 'above';
  }
  if (targetRect.y >= viewportRect.y + viewportRect.height) {
    return 'below';
  }
  return null;
}

// fallow-ignore-next-line complexity
function isDiscoverableOffscreenNode(node: SnapshotNode): boolean {
  if (node.hittable === true) {
    return true;
  }
  const type = (node.type ?? '').toLowerCase();
  return (
    type.includes('button') ||
    type.includes('link') ||
    type.includes('textfield') ||
    type.includes('edittext') ||
    type.includes('searchfield') ||
    type.includes('checkbox') ||
    type.includes('radio') ||
    type.includes('switch') ||
    type.includes('menuitem') ||
    Boolean(extractNodeText(node))
  );
}

function uniqueLabels(nodes: SnapshotNode[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const node of nodes) {
    const label = extractNodeText(node);
    if (!label || seen.has(label)) {
      continue;
    }
    seen.add(label);
    labels.push(label);
  }
  return labels;
}

function markNodeAndAncestorsVisible(
  node: SnapshotNode,
  visibleNodeIndexes: Set<number>,
  byIndex: Map<number, SnapshotNode>,
): void {
  let current: SnapshotNode | undefined = node;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    visited.add(current.index);
    visibleNodeIndexes.add(current.index);
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
}

function findNearestVisibleScrollableAncestor(
  node: SnapshotNode,
  visibleNodeIndexes: Set<number>,
  byIndex: Map<number, SnapshotNode>,
): SnapshotNode | null {
  return findNearestScrollableAncestor(node, byIndex, (current) =>
    visibleNodeIndexes.has(current.index),
  );
}

// fallow-ignore-next-line complexity
function mergeScrollIndicatorDirections(
  nodes: SnapshotNode[],
  visibleNodeIndexes: Set<number>,
  byIndex: Map<number, SnapshotNode>,
  directionsByContainer: Map<number, Set<Direction>>,
  geometryDirectionsByContainer: Map<number, Set<Direction>>,
): void {
  for (const node of nodes) {
    const inferredDirections = inferDirectionsFromScrollIndicator(node);
    if (!inferredDirections || inferredDirections.size === 0) {
      continue;
    }
    const container = findNearestVisibleScrollableAncestor(node, visibleNodeIndexes, byIndex);
    if (!container) {
      continue;
    }
    const directions = directionsByContainer.get(container.index) ?? new Set<Direction>();
    const geometryDirections = geometryDirectionsByContainer.get(container.index);
    for (const direction of inferredDirections) {
      if (geometryDirections && geometryDirections.size > 0 && !geometryDirections.has(direction)) {
        continue;
      }
      directions.add(direction);
    }
    directionsByContainer.set(container.index, directions);
  }
}

function inferDirectionsFromScrollIndicator(node: SnapshotNode): Set<Direction> | null {
  const inferred = inferVerticalScrollIndicatorDirections(node.label, node.value);
  if (!inferred) {
    return null;
  }
  const directions = new Set<Direction>();
  if (inferred.above) {
    directions.add('above');
  }
  if (inferred.below) {
    directions.add('below');
  }
  return directions.size > 0 ? directions : null;
}
