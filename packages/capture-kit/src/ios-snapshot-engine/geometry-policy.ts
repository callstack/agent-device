import type { Rect, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { isPositiveFiniteRect, rectContains } from '@agent-device/kernel/rect';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { collectChildrenByParent, collectSubtreeByParentLinks } from './tree.ts';
import type { IosSnapshotFoldPolicy } from './types.ts';

const SCROLL_CONTAINER_TYPES = new Set(['collectionview', 'scrollview', 'table']);
const VISIBILITY_CARRIER_TYPES = new Set(['application', 'window']);
const NEGLIGIBLE_DECORATION_TOLERANCE = 1;

/**
 * Private UIKit classes are matched by exact name, unlike the substring role tests the occlusion
 * pass uses: this rule decides node membership, so a near miss on a class name has to fail closed
 * rather than widen the cut.
 */
const PRESENTATION_CONTAINER_ROLE = 'uitransitionview';
const PRESENTATION_DIMMING_ROLE = 'uidimmingview';

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

type CoveringPresentation = Readonly<{
  container: RawSnapshotNode;
  dimmingRect: Rect;
}>;

/**
 * UIKit appends each modal presentation as a later sibling of the container it presents over,
 * dims the content behind it with a dimming view that is a direct child of the presentation
 * container, and the host accessibility snapshot reports siblings in that subview order. A
 * presenting container carries only a drop shadow, so a direct-child dimming view separates a
 * modal presentation from an ordinary container, and its dimmed area says which earlier
 * presentation the user can no longer reach. A sheet resting at an undimmed detent keeps that
 * dimming view with user interaction disabled and touches reach the content under it, so the
 * rule asserts containment only when the producer states the dimming view takes touches.
 *
 * Producers that report no UIKit class names or no `userInteractionEnabled` — the XCTest runner,
 * whose own queries already omit modal-contained content — never trigger this rule.
 */
export function collectModalContainedIndexes(
  nodes: readonly RawSnapshotNode[],
): ReadonlySet<number> {
  const childrenByParent = collectChildrenByParent(nodes);
  const contained = new Set<number>();
  for (const siblings of childrenByParent.values()) {
    const covering = findCoveringPresentation(siblings, childrenByParent);
    if (!covering) continue;
    for (const sibling of siblings.slice(0, -1)) {
      if (!isDimmedByPresentation(covering, sibling)) continue;
      contained.add(sibling.index);
      for (const descendant of collectSubtreeByParentLinks(sibling, childrenByParent)) {
        contained.add(descendant.index);
      }
    }
  }
  return contained;
}

function findCoveringPresentation(
  siblings: readonly RawSnapshotNode[],
  childrenByParent: ReadonlyMap<number, RawSnapshotNode[]>,
): CoveringPresentation | undefined {
  const last = siblings.at(-1);
  if (!last || !isPresentationContainer(last)) return undefined;
  const dimming = (childrenByParent.get(last.index) ?? []).find(isPresentationDimmingView);
  if (dimming?.userInteractionEnabled !== true || !isPositiveFiniteRect(dimming.rect)) {
    return undefined;
  }
  return { container: last, dimmingRect: dimming.rect };
}

function isDimmedByPresentation(covering: CoveringPresentation, sibling: RawSnapshotNode): boolean {
  return (
    isPresentationContainer(sibling) &&
    isPositiveFiniteRect(sibling.rect) &&
    rectContains(covering.dimmingRect, sibling.rect)
  );
}

function isPresentationContainer(node: RawSnapshotNode): boolean {
  return hasRole(node, PRESENTATION_CONTAINER_ROLE);
}

function isPresentationDimmingView(node: RawSnapshotNode): boolean {
  return hasRole(node, PRESENTATION_DIMMING_ROLE);
}

function hasRole(node: RawSnapshotNode, role: string): boolean {
  return normalizeType(node.role ?? '') === role;
}
