import type { Rect, SnapshotNode } from '@agent-device/kernel/snapshot';
import { centerOfRect } from '@agent-device/kernel/snapshot';
import { containsPoint, pickLargestRect } from '@agent-device/kernel/rect';
import {
  findNearestAncestor,
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

const SEMANTIC_TOUCH_ROLE_FRAGMENTS = [
  'button',
  'link',
  'menuitem',
  'tabitem',
  'textfield',
  'searchfield',
  'securetextfield',
  'checkbox',
  'radio',
  'switch',
  'cell',
];

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

type ActionableTouchCandidateClassification =
  | { kind: 'equivalent'; node: SnapshotNode }
  | { kind: 'ambiguous'; candidates: SnapshotNode[] };

/**
 * Mutating selector matches may collapse only when their tree structure proves
 * that they describe one action: every candidate is on one ancestor/descendant
 * chain and every candidate resolves to the same actionable node. Geometry may
 * help resolve a wrapper to its control, but never chooses between branches.
 */
export function classifyActionableTouchCandidates(
  nodes: SnapshotNode[],
  candidates: SnapshotNode[],
): ActionableTouchCandidateClassification {
  const first = candidates[0];
  if (!first) return { kind: 'ambiguous', candidates };
  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  if (!candidatesFormSingleAncestryChain(candidates, byIndex)) {
    return { kind: 'ambiguous', candidates };
  }
  const actionable = resolveActionableTouchResolution(nodes, first).node;
  for (const candidate of candidates.slice(1)) {
    if (resolveActionableTouchResolution(nodes, candidate).node.index !== actionable.index) {
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

/**
 * The tree's viewport root as an interaction target: a viewport root node whose
 * rect is exactly the tree root's. Promotion that lands here has retargeted to
 * "the screen" rather than to the thing that matched, which is why the
 * `hittable-ancestor-below-root` promotion stage declines it and `find`
 * excludes it from candidacy and ranking.
 */
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

/** @internal Exposed for focused policy tests. */
export function resolveActionableTouchResolution(
  nodes: SnapshotNode[],
  node: SnapshotNode,
): ActionableTouchResolution {
  if (isSnapshotNodeInteractionBlocked(node)) {
    return { node, reason: 'covered' };
  }
  const descendant = findPreferredActionableDescendant(nodes, node);
  if (descendant?.rect && resolveRectCenter(descendant.rect)) {
    return { node: descendant, reason: 'same-rect-descendant' };
  }
  if (isSemanticTouchTarget(node) && node.rect && resolveRectCenter(node.rect)) {
    return { node, reason: 'semantic-target' };
  }
  const ancestor = findNearestHittableAncestor(nodes, node);
  if (
    ancestor?.rect &&
    !isSnapshotNodeInteractionBlocked(ancestor) &&
    resolveRectCenter(ancestor.rect)
  ) {
    if (isOverlyBroadAncestor(node, ancestor, nodes)) {
      return { node, reason: 'overly-broad-ancestor' };
    }
    return { node: ancestor, reason: 'hittable-ancestor' };
  }
  return { node, reason: 'original' };
}

function findNearestHittableAncestor(
  nodes: SnapshotNode[],
  node: SnapshotNode,
): SnapshotNode | null {
  if (node.hittable) return node;
  return findNearestAncestor(nodes, node, (parent) => parent.hittable === true);
}

function findPreferredActionableDescendant(
  nodes: SnapshotNode[],
  node: SnapshotNode,
): SnapshotNode | null {
  const targetRect = normalizeRect(node.rect);
  if (!targetRect) return null;

  let current = node;
  const visited = new Set<string>();
  while (!visited.has(current.ref)) {
    visited.add(current.ref);
    const sameRectChildren = nodes.filter((candidate) => {
      if (
        candidate.parentIndex !== current.index ||
        !candidate.hittable ||
        isSnapshotNodeInteractionBlocked(candidate)
      ) {
        return false;
      }
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

/**
 * THE canonical interactive-role classification for touch: a node whose
 * type/role/subrole names a control that independently receives taps. Shared
 * by the hittable-ancestor promotion above and #1280's press-retarget
 * competing-descendant guard (`press-retarget.ts`) — one list, never a
 * parallel copy.
 */
export function isSemanticTouchTarget(node: SnapshotNode): boolean {
  const roles = [node.type, node.role, node.subrole].map((value) => normalizeType(value ?? ''));
  return roles.some(isSemanticTouchRole);
}

function isSemanticTouchRole(role: string): boolean {
  // Match Tab exactly so broad roles like Table/TabBar do not become touch targets.
  return (
    role === 'tab' || SEMANTIC_TOUCH_ROLE_FRAGMENTS.some((fragment) => role.includes(fragment))
  );
}

function isOverlyBroadAncestor(
  node: SnapshotNode,
  ancestor: SnapshotNode,
  nodes: SnapshotNode[],
): boolean {
  const nodeRect = normalizeRect(node.rect);
  const ancestorRect = normalizeRect(ancestor.rect);
  if (!nodeRect || !ancestorRect) return false;
  if (isScrollingContainer(ancestor) && !areRectsApproximatelyEqual(nodeRect, ancestorRect)) {
    return true;
  }
  const rootViewportRect = resolveRootViewportRect(nodes, nodeRect);
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

function resolveRootViewportRect(nodes: SnapshotNode[], targetRect: Rect): Rect | null {
  const targetCenter = centerOfRect(targetRect);
  const viewportRects = nodes
    .filter(isViewportRootNode)
    .map((node) => normalizeRect(node.rect))
    .filter((rect): rect is Rect => rect !== null);
  if (viewportRects.length === 0) return null;

  const containingRects = viewportRects.filter((rect) =>
    containsPoint(rect, targetCenter.x, targetCenter.y),
  );
  return pickLargestRect(containingRects.length > 0 ? containingRects : viewportRects);
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
