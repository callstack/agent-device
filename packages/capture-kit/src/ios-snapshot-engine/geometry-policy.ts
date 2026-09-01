import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { containsPoint, isPositiveFiniteRect } from '@agent-device/kernel/rect';
import { normalizeType } from '@agent-device/contracts/snapshot';
import type { IosSnapshotFoldPolicy } from './types.ts';

const SCROLL_CONTAINER_TYPES = new Set(['collectionview', 'scrollview', 'table']);
const VISIBILITY_CARRIER_TYPES = new Set(['application', 'window']);
const NEGLIGIBLE_DECORATION_TOLERANCE = 1;

export type TraversalState = Readonly<{
  projectedOut: boolean;
  ancestorClip?: Rect;
}>;

export type BranchState = Readonly<{
  traversal: TraversalState;
  anchor?: { index: number; rect: Rect };
  keptIndex?: number;
  keptDepth: number;
}>;

export type GeometryDecision = Readonly<{
  isIncluded: boolean;
  descendants: TraversalState;
  effectiveRect?: Rect;
  hiddenContentFrame?: Rect;
  establishesScrollAnchor: boolean;
}>;

export function isGeometricallyActionable(
  enabled: boolean,
  rect: Rect | undefined,
  viewport: Rect,
): boolean {
  return Boolean(
    enabled &&
    isPositiveFiniteRect(rect) &&
    containsPoint(viewport, rect.x + rect.width / 2, rect.y + rect.height / 2),
  );
}

export function rootTraversal(): TraversalState {
  return { projectedOut: false };
}

export function traversalDecision(
  node: RawSnapshotNode,
  parentTraversal: TraversalState,
  viewport: Rect,
  interactiveOnly: boolean,
  hasChildren: boolean,
  policy: IosSnapshotFoldPolicy,
): GeometryDecision {
  const ancestorClip = policy === 'cursor-projected' ? parentTraversal.ancestorClip : undefined;
  const effectiveRect = effectiveSnapshotRect(node.rect, viewport, ancestorClip);
  const hasFrame = isPositiveFiniteRect(normalizeRect(node.rect));
  const intersectsClip = isPositiveFiniteRect(effectiveRect);
  const type = normalizeType(node.type ?? '');
  const projectedOut = descendantsProjectedOut(
    policy,
    parentTraversal.projectedOut,
    hasFrame,
    intersectsClip,
    type,
    hasChildren,
  );
  const visible =
    presentationVisible(policy, parentTraversal.projectedOut, hasFrame, intersectsClip) &&
    !isNegligibleDecoration(node, hasFrame, policy);
  const isIncluded = shouldInclude(node, visible, interactiveOnly, policy);
  const establishesScrollAnchor = ownsScrollAnchor(type, isIncluded, intersectsClip, hasChildren);
  const hiddenFrame = hiddenContentFrame(
    policy,
    parentTraversal.projectedOut,
    hasFrame,
    intersectsClip,
    node,
  );
  return {
    isIncluded,
    descendants: descendantTraversal(
      policy,
      projectedOut,
      ancestorClip,
      effectiveRect,
      establishesScrollAnchor,
    ),
    effectiveRect,
    ...(hiddenFrame ? { hiddenContentFrame: hiddenFrame } : {}),
    establishesScrollAnchor,
  };
}

function effectiveSnapshotRect(
  reportedRect: Rect | undefined,
  viewport: Rect,
  ancestorClip?: Rect,
): Rect | undefined {
  const normalized = normalizeRect(reportedRect);
  if (!normalized) return undefined;
  let effective = intersectRect(normalized, viewport);
  if (ancestorClip) effective = intersectRect(effective, ancestorClip);
  return effective;
}

function descendantsProjectedOut(
  policy: IosSnapshotFoldPolicy,
  parentProjectedOut: boolean,
  hasFrame: boolean,
  intersectsClip: boolean,
  type: string,
  hasChildren: boolean,
): boolean {
  if (policy === 'plain-viewport') return !intersectsClip;
  return parentProjectedOut || (hasFrame && !intersectsClip && ownsDescendants(type, hasChildren));
}

function presentationVisible(
  policy: IosSnapshotFoldPolicy,
  parentProjectedOut: boolean,
  hasFrame: boolean,
  intersectsClip: boolean,
): boolean {
  if (policy === 'plain-viewport') return intersectsClip;
  return !parentProjectedOut && (!hasFrame || intersectsClip);
}

function isNegligibleDecoration(
  node: RawSnapshotNode,
  hasFrame: boolean,
  policy: IosSnapshotFoldPolicy,
): boolean {
  if (
    policy !== 'cursor-projected' ||
    node.parentIndex === undefined ||
    hasSemanticContent(node) ||
    !hasFrame
  ) {
    return false;
  }
  return (
    normalizedRectWidth(node.rect) <= NEGLIGIBLE_DECORATION_TOLERANCE ||
    normalizedRectHeight(node.rect) <= NEGLIGIBLE_DECORATION_TOLERANCE
  );
}

function descendantTraversal(
  policy: IosSnapshotFoldPolicy,
  projectedOut: boolean,
  ancestorClip: Rect | undefined,
  effectiveRect: Rect | undefined,
  establishesScrollAnchor: boolean,
): TraversalState {
  return {
    projectedOut,
    ...(policy === 'cursor-projected' && establishesScrollAnchor
      ? { ancestorClip: effectiveRect }
      : { ancestorClip }),
  };
}

function hiddenContentFrame(
  policy: IosSnapshotFoldPolicy,
  parentProjectedOut: boolean,
  hasFrame: boolean,
  intersectsClip: boolean,
  node: RawSnapshotNode,
): Rect | undefined {
  if (policy !== 'cursor-projected' || parentProjectedOut || !hasFrame || intersectsClip) {
    return undefined;
  }
  return normalizeRect(node.rect);
}

function ownsDescendants(type: string, hasChildren: boolean): boolean {
  return hasChildren && (type === 'cell' || SCROLL_CONTAINER_TYPES.has(type));
}

function ownsScrollAnchor(
  type: string,
  isIncluded: boolean,
  intersectsClip: boolean,
  hasChildren: boolean,
): boolean {
  return isIncluded && intersectsClip && hasChildren && SCROLL_CONTAINER_TYPES.has(type);
}

function shouldInclude(
  node: RawSnapshotNode,
  visible: boolean,
  interactiveOnly: boolean,
  policy: IosSnapshotFoldPolicy,
): boolean {
  if (node.parentIndex === undefined) return true;
  const type = normalizeType(node.type ?? '');
  if (policy === 'plain-viewport' && interactiveOnly && !visible && type !== 'application') {
    return false;
  }
  return VISIBILITY_CARRIER_TYPES.has(type) || visible;
}

function hasSemanticContent(node: RawSnapshotNode): boolean {
  return [node.label, node.identifier, node.value].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

function normalizeRect(rect: Rect | undefined): Rect | undefined {
  if (!rect) return undefined;
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return undefined;
  if (rect.width < 0 || rect.height < 0) return undefined;
  return { ...rect, width: Math.max(0, rect.width), height: Math.max(0, rect.height) };
}

function normalizedRectWidth(rect: Rect | undefined): number {
  return normalizeRect(rect)?.width ?? 0;
}

function normalizedRectHeight(rect: Rect | undefined): number {
  return normalizeRect(rect)?.height ?? 0;
}

function intersectRect(left: Rect, right: Rect): Rect {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge <= x || bottomEdge <= y) {
    return { x: left.x, y: left.y, width: 0, height: 0 };
  }
  return {
    x: rightEdge > x ? x : left.x,
    y: bottomEdge > y ? y : left.y,
    width: rightEdge - x,
    height: bottomEdge - y,
  };
}
