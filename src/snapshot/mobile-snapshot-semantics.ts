import {
  containsPoint,
  isRectVisibleInViewport,
  resolveViewportRect,
} from '../utils/rect-visibility.ts';
import { inferVerticalScrollIndicatorDirections } from '../utils/scroll-indicator.ts';
import type { HiddenContentHint, Rect, SnapshotNode } from '../kernel/snapshot.ts';
import { buildSnapshotNodeMap, displayNodeLabel } from './snapshot-tree.ts';
import { isScrollableNodeLike } from '../utils/scrollable.ts';

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

export function isNodeVisibleInEffectiveViewport(
  node: Pick<SnapshotNode, 'rect' | 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'>,
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): boolean {
  if (!node.rect) {
    return true;
  }
  const viewport = resolveEffectiveViewportRect(node, nodes, byIndex);
  if (!viewport) {
    return true;
  }
  return isRectVisibleInViewport(node.rect, viewport);
}

// Effective-viewport visibility measures a node against its nearest scrollable
// ancestor, so items inside an off-screen container (e.g. a closed drawer's own
// ScrollView at negative x) still read as "visible" within that container.
// On-screen visibility additionally requires the node's CENTER — the point an
// interaction would tap — to sit inside the root Application/Window viewport.
// Edge overlap is not enough: a mostly-off-screen drawer container can graze
// the viewport by a fraction of a pixel while its center (the tap point) is
// far off-screen. Interaction guards and selector disambiguation use this
// stricter form; scroll-direction summaries keep the effective form.
export function isNodeVisibleOnScreen(
  node: Pick<SnapshotNode, 'rect' | 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'>,
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): boolean {
  if (!node.rect) {
    return true;
  }
  if (!isNodeVisibleInEffectiveViewport(node, nodes, byIndex)) {
    return false;
  }
  const rootViewport = resolveViewportRect(nodes, node.rect);
  return isTapPointInsideViewport(node.rect, rootViewport);
}

// The tap-point rule shared with the iOS runner (ADR 0011 Layer 2): the tap
// point is the rect's exact CENTER; it is inside the viewport iff it lies
// within the frame, edges inclusive. A missing, empty, or invalid viewport
// fails open (allowed) — resolving the best available viewport is the
// caller's job, and the rule must not turn a missing frame into a refusal.
//
// Swift twin: apple-runner/AgentDeviceRunner/AgentDeviceRunnerUITests/
// RunnerTapPointPolicy.swift (TapPointPolicy.isAllowed). Parity is enforced
// by the golden fixture table contracts/fixtures/tap-point-policy.json,
// asserted on both sides (tap-point-policy-parity.test.ts / the gated XCTest
// in RunnerTapPointPolicy.swift). Change the rule only via the table.
export function isTapPointInsideViewport(rect: Rect, viewport: Rect | null): boolean {
  if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
    return true;
  }
  return containsPoint(viewport, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

export function resolveEffectiveViewportRect(
  node: Pick<SnapshotNode, 'rect' | 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'>,
  nodes: SnapshotNode[],
  byIndex: Map<number, SnapshotNode> = buildSnapshotNodeMap(nodes),
): Rect | null {
  const clippingAncestorRect = findNearestScrollableAncestorRect(node, byIndex);
  if (clippingAncestorRect) {
    return clippingAncestorRect;
  }
  return resolveViewportRect(nodes, node.rect ?? { x: 0, y: 0, width: 0, height: 0 });
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
    Boolean(displayNodeLabel(node))
  );
}

function uniqueLabels(nodes: SnapshotNode[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const node of nodes) {
    const label = displayNodeLabel(node);
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
  return findNearestScrollableAncestorMatching(node, byIndex, (current) =>
    visibleNodeIndexes.has(current.index),
  );
}

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

function findNearestScrollableAncestorRect(
  node: Pick<SnapshotNode, 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'>,
  byIndex: Map<number, SnapshotNode>,
): Rect | null {
  return (
    findNearestScrollableAncestorMatching(node, byIndex, (current) => Boolean(current.rect))
      ?.rect ?? null
  );
}

function findNearestScrollableAncestorMatching(
  node: Pick<SnapshotNode, 'index' | 'parentIndex' | 'type' | 'role' | 'subrole'>,
  byIndex: Map<number, SnapshotNode>,
  predicate: (node: SnapshotNode) => boolean,
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
