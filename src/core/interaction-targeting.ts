import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { centerOfRect } from '@agent-device/kernel/snapshot';
import { containsPoint, pickLargestRect } from '@agent-device/kernel/rect';
import {
  findNearestAncestor,
  findSnapshotAncestor,
  normalizeType,
  isViewportRootNode,
} from '@agent-device/contracts/snapshot';
import { isSnapshotNodeInteractionBlocked } from '../snapshot/snapshot-occlusion.ts';
import {
  areRectsApproximatelyEqual,
  normalizeRect,
  resolveRectCenter,
} from '../utils/rect-center.ts';
import { intersectArea } from '../utils/screenshot-geometry.ts';
import { isSemanticTouchTarget } from './touch-semantics.ts';

type ActionableTouchResolutionReason =
  | 'same-rect-descendant'
  | 'semantic-target'
  | 'hittable-ancestor'
  | 'overly-broad-ancestor'
  | 'original'
  | 'covered';

type ActionableTouchResolution = {
  node: SnapshotNode;
  reason: ActionableTouchResolutionReason;
};

type ActionableTouchIndex = {
  nodesByIndex: ReadonlyMap<number, SnapshotNode>;
  childrenByParentIndex: ReadonlyMap<number, readonly SnapshotNode[]>;
  viewportRootRects: readonly Rect[];
};

type ActionableTouchCandidateClassification =
  | { kind: 'equivalent'; node: SnapshotNode }
  | { kind: 'ambiguous'; candidates: SnapshotNode[] };

export function classifyActionableTouchCandidates(
  nodes: SnapshotNode[],
  candidates: SnapshotNode[],
): ActionableTouchCandidateClassification {
  const first = candidates[0];
  if (!first) return { kind: 'ambiguous', candidates };
  const index = buildActionableTouchIndex(nodes);
  if (!candidatesFormSingleAncestryChain(candidates, index.nodesByIndex)) {
    return { kind: 'ambiguous', candidates };
  }
  const actionable = resolveActionableTouchResolutionWithIndex(nodes, first, index).node;
  for (const candidate of candidates.slice(1)) {
    if (
      resolveActionableTouchResolutionWithIndex(nodes, candidate, index).node.index !==
      actionable.index
    ) {
      return { kind: 'ambiguous', candidates };
    }
  }
  return { kind: 'equivalent', node: actionable };
}

function candidatesFormSingleAncestryChain(
  candidates: SnapshotNode[],
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      if (!isAncestorOf(left, right, byIndex) && !isAncestorOf(right, left, byIndex)) return false;
    }
  }
  return true;
}

function isAncestorOf(
  candidateAncestor: SnapshotNode,
  candidateDescendant: SnapshotNode,
  byIndex: ReadonlyMap<number, SnapshotNode>,
): boolean {
  let current = candidateDescendant;
  const visited = new Set<number>();
  while (current.parentIndex !== undefined && !visited.has(current.index)) {
    visited.add(current.index);
    if (current.parentIndex === candidateAncestor.index) return true;
    const parent = byIndex.get(current.parentIndex);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

export function isRootInteractionContainer(
  node: SnapshotNode,
  root: SnapshotNode | undefined,
): boolean {
  if (!root?.rect || !node.rect) return false;
  if (!isViewportRootNode(node)) return false;
  const left = node.rect;
  const right = root.rect;
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

export function resolveActionableTouchResolution(
  nodes: SnapshotNode[],
  node: SnapshotNode,
): ActionableTouchResolution {
  return resolveActionableTouchResolutionWithIndex(nodes, node);
}

/** Resolves many candidates against one snapshot without rebuilding its indexes. */
export function createActionableTouchResolver(
  nodes: SnapshotNode[],
): (node: SnapshotNode) => ActionableTouchResolution {
  const index = buildActionableTouchIndex(nodes);
  return (node) => resolveActionableTouchResolutionWithIndex(nodes, node, index);
}

function resolveActionableTouchResolutionWithIndex(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index?: ActionableTouchIndex,
): ActionableTouchResolution {
  if (isSnapshotNodeInteractionBlocked(node)) {
    return { node, reason: 'covered' };
  }
  return (
    resolvePreferredDescendant(nodes, node, index) ??
    resolveSemanticTarget(node) ??
    resolveHittableAncestor(nodes, node, index) ?? { node, reason: 'original' }
  );
}

function resolvePreferredDescendant(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): ActionableTouchResolution | null {
  const descendant = findPreferredActionableDescendant(nodes, node, index);
  return descendant?.rect && resolveRectCenter(descendant.rect)
    ? { node: descendant, reason: 'same-rect-descendant' }
    : null;
}

function resolveSemanticTarget(node: SnapshotNode): ActionableTouchResolution | null {
  return isSemanticTouchTarget(node) && node.rect && resolveRectCenter(node.rect)
    ? { node, reason: 'semantic-target' }
    : null;
}

function resolveHittableAncestor(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): ActionableTouchResolution | null {
  const ancestor = findNearestHittableAncestor(nodes, node, index);
  if (!ancestor?.rect || isSnapshotNodeInteractionBlocked(ancestor)) return null;
  if (!resolveRectCenter(ancestor.rect)) return null;
  if (isOverlyBroadAncestor(node, ancestor, nodes, index)) {
    return { node, reason: 'overly-broad-ancestor' };
  }
  return { node: ancestor, reason: 'hittable-ancestor' };
}

function findNearestHittableAncestor(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): SnapshotNode | null {
  if (node.hittable) return node;
  const isHittable = (parent: SnapshotNode) => parent.hittable === true;
  if (!index) return findNearestAncestor(nodes, node, isHittable);
  return findSnapshotAncestor(nodes, node, index.nodesByIndex, (parent) =>
    isHittable(parent) ? parent : null,
  );
}

function findPreferredActionableDescendant(
  nodes: SnapshotNode[],
  node: SnapshotNode,
  index: ActionableTouchIndex | undefined,
): SnapshotNode | null {
  const targetRect = normalizeRect(node.rect);
  if (!targetRect) return null;

  let current = node;
  const visited = new Set<string>();
  while (!visited.has(current.ref)) {
    visited.add(current.ref);
    const children = index
      ? (index.childrenByParentIndex.get(current.index) ?? [])
      : nodes.filter((candidate) => candidate.parentIndex === current.index);
    const sameRectChildren = children.filter((candidate) => {
      if (!candidate.hittable || isSnapshotNodeInteractionBlocked(candidate)) return false;
      const candidateRect = normalizeRect(candidate.rect);
      return candidateRect ? areRectsApproximatelyEqual(candidateRect, targetRect) : false;
    });
    if (sameRectChildren.length !== 1) {
      break;
    }
    current = sameRectChildren[0]!;
  }

  return current === node ? null : current;
}

function isOverlyBroadAncestor(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodes: SnapshotNode[],
  index: ActionableTouchIndex | undefined,
): boolean {
  const nodeRect = normalizeRect(node.rect);
  const ancestorRect = normalizeRect(ancestor.rect);
  if (!nodeRect || !ancestorRect) return false;
  if (isScrollingContainer(ancestor) && !areRectsApproximatelyEqual(nodeRect, ancestorRect)) {
    return true;
  }
  const rootViewportRect = resolveRootViewportRect(nodes, nodeRect, index);
  if (!rootViewportRect) return false;
  if (!isRectViewportSized(ancestorRect, rootViewportRect)) return false;
  return !areRectsApproximatelyEqual(nodeRect, ancestorRect);
}

function isScrollingContainer(node: SnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return (
    type.includes('scrollview') ||
    type.includes('scrollarea') ||
    type.includes('listview') ||
    type.includes('recyclerview') ||
    type.includes('collectionview') ||
    type === 'list' ||
    type === 'table' ||
    type === 'collection'
  );
}

function resolveRootViewportRect(
  nodes: SnapshotNode[],
  targetRect: Rect,
  index: ActionableTouchIndex | undefined,
): Rect | null {
  const targetCenter = centerOfRect(targetRect);
  const viewportRects =
    index?.viewportRootRects ??
    nodes
      .filter(isViewportRootNode)
      .map((node) => normalizeRect(node.rect))
      .filter((rect): rect is Rect => rect !== null);
  if (viewportRects.length === 0) return null;

  const containingRects = viewportRects.filter((rect) =>
    containsPoint(rect, targetCenter.x, targetCenter.y),
  );
  return pickLargestRect(containingRects.length > 0 ? containingRects : viewportRects);
}

function buildActionableTouchIndex(nodes: readonly SnapshotNode[]): ActionableTouchIndex {
  const nodesByIndex = new Map<number, SnapshotNode>();
  const childrenByParentIndex = new Map<number, SnapshotNode[]>();
  const viewportRootRects: Rect[] = [];
  for (const node of nodes) {
    nodesByIndex.set(node.index, node);
    if (typeof node.parentIndex === 'number') {
      const children = childrenByParentIndex.get(node.parentIndex);
      if (children) children.push(node);
      else childrenByParentIndex.set(node.parentIndex, [node]);
    }
    if (isViewportRootNode(node)) {
      const rect = normalizeRect(node.rect);
      if (rect) viewportRootRects.push(rect);
    }
  }
  return { nodesByIndex, childrenByParentIndex, viewportRootRects };
}

function isRectViewportSized(rect: Rect, viewportRect: Rect): boolean {
  const overlapArea = intersectArea(rect, viewportRect);
  const rectArea = rect.width * rect.height;
  const viewportArea = viewportRect.width * viewportRect.height;
  if (overlapArea <= 0 || rectArea <= 0 || viewportArea <= 0) return false;

  const viewportCoverage = overlapArea / viewportArea;
  const rectCoverage = overlapArea / rectArea;
  return viewportCoverage >= 0.9 && rectCoverage >= 0.8;
}
