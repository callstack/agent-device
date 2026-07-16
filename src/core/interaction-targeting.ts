import type { Rect, SnapshotNode } from '../kernel/snapshot.ts';
import { centerOfRect } from '../kernel/snapshot.ts';
import { containsPoint, pickLargestRect } from '../utils/rect-visibility.ts';
import { findNearestHittableAncestor, normalizeType } from '../snapshot/snapshot-processing.ts';
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

export function resolveActionableTouchNode(
  nodes: SnapshotNode[],
  node: SnapshotNode,
): SnapshotNode {
  return resolveActionableTouchResolution(nodes, node).node;
}

/** @internal Exposed for focused policy tests; runtime callers should use resolveActionableTouchNode. */
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
  const rootViewportRect = resolveRootViewportRect(nodes, nodeRect);
  if (!rootViewportRect) return false;
  if (!isRectViewportSized(ancestorRect, rootViewportRect)) return false;
  return !areRectsApproximatelyEqual(nodeRect, ancestorRect);
}

function resolveRootViewportRect(nodes: SnapshotNode[], targetRect: Rect): Rect | null {
  const targetCenter = centerOfRect(targetRect);
  const viewportRects = nodes
    .filter((node) => {
      const type = (node.type ?? '').toLowerCase();
      return type.includes('application') || type.includes('window');
    })
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
