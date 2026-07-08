import type { RawSnapshotNode, Rect } from '../kernel/snapshot.ts';
import { centerOfRect } from '../kernel/snapshot.ts';
import { areRectsApproximatelyEqual, normalizeRect } from '../utils/rect-center.ts';
import { containsPoint } from '../utils/rect-visibility.ts';
import { normalizeType } from '../utils/text-surface.ts';

const COVERED_PRESENTATION_HINT = 'covered';
const OVERLAY_KIND_FRAGMENTS = [
  'tabbar',
  'toolbar',
  'navigationbar',
  'bottomnavigation',
  'bottomnavigationview',
  'sheet',
  'dialog',
  'alert',
  'popover',
  'menu',
];
const SEMANTIC_TOUCH_KIND_FRAGMENTS = [
  'button',
  'link',
  'menuitem',
  'tabitem',
  'textfield',
  'searchfield',
  'edittext',
  'checkbox',
  'radio',
  'switch',
  'cell',
];

type OcclusionScan = {
  nodes: RawSnapshotNode[];
  byIndex: Map<number, RawSnapshotNode>;
  overlayPositions: number[];
};

export type SnapshotOcclusionOptions = {
  isAdditionalOverlayNode?: (node: RawSnapshotNode) => boolean;
};

export function annotateCoveredSnapshotNodes(
  nodes: RawSnapshotNode[],
  options: SnapshotOcclusionOptions = {},
): RawSnapshotNode[] {
  if (nodes.length < 2) return nodes;

  const annotated = [...nodes];
  const byIndex = new Map(annotated.map((node) => [node.index, node]));
  const scan: OcclusionScan = {
    nodes: annotated,
    byIndex,
    overlayPositions: annotated.flatMap((node, position) =>
      isOverlayLikeNode(node, byIndex, options) ? [position] : [],
    ),
  };
  let changed = false;
  for (const [position, node] of annotated.entries()) {
    if (!isCandidateTouchNode(node)) continue;
    const cover = findCoveringNode(scan, position, node, options);
    if (!cover) continue;
    changed = true;
    const coveredNode = {
      ...node,
      hittable: false,
      interactionBlocked: 'covered' as const,
      presentationHints: mergeCoveredHint(node.presentationHints),
    };
    annotated[position] = coveredNode;
    scan.byIndex.set(coveredNode.index, coveredNode);
  }

  return changed ? annotated : nodes;
}

export function isSnapshotNodeInteractionBlocked(
  node: Pick<RawSnapshotNode, 'interactionBlocked'>,
): boolean {
  return node.interactionBlocked !== undefined;
}

function findCoveringNode(
  scan: OcclusionScan,
  targetPosition: number,
  target: RawSnapshotNode,
  options: SnapshotOcclusionOptions,
): RawSnapshotNode | null {
  const targetRect = positiveRect(target.rect);
  if (!targetRect) return null;
  const center = centerOfRect(targetRect);

  for (const position of scan.overlayPositions) {
    if (position <= targetPosition) continue;
    const candidate = scan.nodes[position];
    if (candidate && canCoverPoint(scan, position, target, targetRect, center, options)) {
      return candidate;
    }
  }

  return null;
}

function canCoverPoint(
  scan: OcclusionScan,
  candidatePosition: number,
  target: RawSnapshotNode,
  targetRect: Rect,
  point: { x: number; y: number },
  options: SnapshotOcclusionOptions,
): boolean {
  const candidate = scan.nodes[candidatePosition];
  if (!candidate) return false;
  const coverRect = visibleCoverRect(scan, candidatePosition, target, targetRect, options);
  return Boolean(coverRect && containsPoint(coverRect, point.x, point.y));
}

function visibleCoverRect(
  scan: OcclusionScan,
  candidatePosition: number,
  target: RawSnapshotNode,
  targetRect: Rect,
  options: SnapshotOcclusionOptions,
): Rect | null {
  const candidate = scan.nodes[candidatePosition];
  if (!candidate || !isOverlayLikeNode(candidate, scan.byIndex, options)) return null;
  if (areRelatedSnapshotNodes(target, candidate, scan.byIndex)) return null;
  const candidateRect = positiveRect(candidate.rect);
  if (!candidateRect || areRectsApproximatelyEqual(targetRect, candidateRect)) return null;
  if (findCoveringNode(scan, candidatePosition, candidate, options)) return null;
  return candidateRect;
}

function isCandidateTouchNode(node: RawSnapshotNode): boolean {
  if (!positiveRect(node.rect)) return false;
  if (node.hittable === true) return true;
  if (isSemanticTouchNode(node)) return true;
  return Boolean(node.label?.trim() || node.value?.trim() || node.identifier?.trim());
}

function isOverlayLikeNode(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  options: SnapshotOcclusionOptions,
): boolean {
  if (!positiveRect(node.rect)) return false;
  if (isViewportRoot(node)) return false;
  // This is a presentation-order heuristic: only known floating UI chrome should cover
  // later targets. Generic hittable containers can appear later without being visually on top.
  return (
    nodeKindIncludesAny(node, OVERLAY_KIND_FRAGMENTS) ||
    isAdditionalOverlayRootNode(node, byIndex, options)
  );
}

function isAdditionalOverlayRootNode(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  options: SnapshotOcclusionOptions,
): boolean {
  if (options.isAdditionalOverlayNode?.(node) !== true) return false;
  return !hasRenderableAdditionalOverlayAncestor(node, byIndex, options);
}

function hasRenderableAdditionalOverlayAncestor(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  options: SnapshotOcclusionOptions,
): boolean {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    if (isRenderableAdditionalOverlayNode(current, options)) return true;
    visited.add(current.index);
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return false;
}

function isRenderableAdditionalOverlayNode(
  node: RawSnapshotNode,
  options: SnapshotOcclusionOptions,
): boolean {
  return (
    options.isAdditionalOverlayNode?.(node) === true &&
    positiveRect(node.rect) !== null &&
    !isViewportRoot(node)
  );
}

function isSemanticTouchNode(node: RawSnapshotNode): boolean {
  return nodeKindIncludesAny(node, SEMANTIC_TOUCH_KIND_FRAGMENTS);
}

function nodeKindIncludesAny(
  node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>,
  fragments: readonly string[],
): boolean {
  const normalized = normalizeNodeKind(node);
  return fragments.some((fragment) => normalized.includes(fragment));
}

function normalizeNodeKind(node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>): string {
  return [node.type, node.role, node.subrole].map((value) => normalizeType(value ?? '')).join(' ');
}

function isViewportRoot(node: RawSnapshotNode): boolean {
  const normalized = normalizeNodeKind(node);
  return normalized.includes('application') || normalized.includes('window');
}

function areRelatedSnapshotNodes(
  left: RawSnapshotNode,
  right: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
): boolean {
  return isSnapshotAncestor(left, right, byIndex) || isSnapshotAncestor(right, left, byIndex);
}

function isSnapshotAncestor(
  ancestor: RawSnapshotNode,
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
): boolean {
  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    if (current.index === ancestor.index) return true;
    visited.add(current.index);
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return false;
}

function positiveRect(rect: RawSnapshotNode['rect']): Rect | null {
  const normalized = normalizeRect(rect);
  return normalized && normalized.width > 0 && normalized.height > 0 ? normalized : null;
}

function mergeCoveredHint(hints: string[] | undefined): string[] {
  return Array.from(new Set([...(hints ?? []), COVERED_PRESENTATION_HINT]));
}
