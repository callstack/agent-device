import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { centerOfRect } from '@agent-device/kernel/snapshot';
import { areRectsApproximatelyEqual, normalizeRect } from '../utils/rect-center.ts';
import { containsPoint } from '@agent-device/kernel/rect';
import { normalizeType, isViewportRootNode } from '@agent-device/contracts/snapshot';

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
const VIEWPORT_CHROME_KIND_FRAGMENTS = ['tabbar', 'toolbar', 'navigationbar'];
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

/**
 * The read side of one occlusion pass. Everything here is IMMUTABLE for the
 * pass's lifetime: `nodes`/`byIndex` are the caller's input, never the
 * annotated output, so every cover decision — including the caller-supplied
 * `isAdditionalOverlayNode` predicate and ancestor classification — evaluates
 * against the same state no matter when it runs. That immutability is what
 * makes `coverCache` sound: each position's "is it covered by something
 * later" question has exactly one answer per pass, so caching it is safe.
 * Without the cache, `findCoveringNode` -> `visibleCoverRect` ->
 * `findCoveringNode` recurses once per (position, later-position) pair
 * without bound, which is O(2^overlayPositions.length): a snapshot with ~40
 * mutually-overlapping overlay-like nodes (every key of an open Android IME
 * keyboard, each classified via `isAdditionalOverlayNode`) pins the event
 * loop for minutes. Annotations are applied in a separate output pass and
 * never feed back into decisions.
 */
type OcclusionScan = {
  nodes: readonly RawSnapshotNode[];
  byIndex: Map<number, RawSnapshotNode>;
  overlayPositions: number[];
  coverCache: Map<number, RawSnapshotNode | null>;
};

export type SnapshotOcclusionOptions = {
  /** Backend-declared overlay roots that use the shared geometric scan (for example Android IME). */
  isAdditionalOverlayNode?: (node: RawSnapshotNode) => boolean;
};

// Mutation-lane note: the `nodes.length < 2` early return below is provably
// redundant — with 0 or 1 nodes, `coveredPositions` can never be non-empty,
// so the *other* early return a few lines down (`coveredPositions.length ===
// 0`) already returns `nodes` unchanged by the same reference. This one is a
// pure allocation-avoiding fast path, not a distinct behavior.
export function annotateCoveredSnapshotNodes(
  nodes: RawSnapshotNode[],
  options: SnapshotOcclusionOptions = {},
): RawSnapshotNode[] {
  if (nodes.length < 2) return nodes;

  const byIndex = new Map(nodes.map((node) => [node.index, node]));
  const scan: OcclusionScan = {
    nodes,
    byIndex,
    // Mutation-lane note: replacing the `[]` (non-overlay) branch with a
    // non-empty placeholder would only add extra, non-numeric entries to
    // this array; every consumer treats it as a plain array of positions to
    // compare/index with, so a stray non-numeric entry is inert (fails the
    // comparison, indexes to `undefined`) rather than observable.
    overlayPositions: nodes.flatMap((node, position) =>
      isOverlayLikeNode(node, byIndex, options) ? [position] : [],
    ),
    coverCache: new Map(),
  };
  const coveredPositions: number[] = [];
  for (const [position, node] of nodes.entries()) {
    if (!isCandidateTouchNode(node)) continue;
    if (findCoveringNode(scan, position, node, options)) coveredPositions.push(position);
  }
  return annotateCoveredPositions(nodes, coveredPositions);
}

/** Applies backend-owned covered decisions through the same publication annotation contract. */
export function annotateSnapshotNodesCoveredByPolicy(
  nodes: RawSnapshotNode[],
  isCovered: (node: RawSnapshotNode) => boolean,
): RawSnapshotNode[] {
  const coveredPositions: number[] = [];
  for (const [position, node] of nodes.entries()) {
    if (isCandidateTouchNode(node) && isCovered(node)) coveredPositions.push(position);
  }
  return annotateCoveredPositions(nodes, coveredPositions);
}

function annotateCoveredPositions(
  nodes: RawSnapshotNode[],
  coveredPositions: readonly number[],
): RawSnapshotNode[] {
  if (coveredPositions.length === 0) return nodes;
  const annotated = [...nodes];
  for (const position of coveredPositions) {
    const node = nodes[position]!;
    annotated[position] = {
      ...node,
      hittable: false,
      interactionBlocked: 'covered' as const,
      presentationHints: mergeCoveredHint(node.presentationHints),
    };
  }
  return annotated;
}

export function isSnapshotNodeInteractionBlocked(
  node: Pick<RawSnapshotNode, 'interactionBlocked'>,
): boolean {
  return node.interactionBlocked !== undefined;
}

// Mutation-lane note: several guards across this call chain are provably
// redundant, not undertested:
//   - `findCoveringNode`'s `!targetRect` — every caller (the outer loop below
//     and `visibleCoverRect`'s recursive call) only ever passes a node whose
//     rect was already confirmed positive (via `isCandidateTouchNode` or the
//     `candidateRect` check just before the recursive call).
//   - `canCoverPoint`'s and `visibleCoverRect`'s `!candidate` — `position`
//     always comes from `scan.overlayPositions`, itself built by mapping
//     over `scan.nodes`, so it is always a valid index into that same array.
//   - `visibleCoverRect`'s `!isOverlayLikeNode(candidate, ...)` — a position
//     only lands in `overlayPositions` because this exact predicate, over
//     the exact same pristine (node, byIndex, options), already returned
//     true when the array was built.
function findCoveringNode(
  scan: OcclusionScan,
  targetPosition: number,
  target: RawSnapshotNode,
  options: SnapshotOcclusionOptions,
): RawSnapshotNode | null {
  const cached = scan.coverCache.get(targetPosition);
  if (cached !== undefined) return cached;
  // Reentrancy guard: an additional Android overlay may precede an app target
  // in the cross-window traversal, while that target may itself be overlay-like.
  // Seed `null` before following either direction so such a cycle fails closed
  // instead of re-entering.
  scan.coverCache.set(targetPosition, null);

  const targetRect = positiveRect(target.rect);
  if (!targetRect) return finishFindCoveringNode(scan, targetPosition, null);
  const center = centerOfRect(targetRect);
  const targetIsAdditionalOverlay = options.isAdditionalOverlayNode?.(target) === true;

  for (const position of scan.overlayPositions) {
    if (
      !canPositionCoverTarget(scan, position, targetPosition, targetIsAdditionalOverlay, options)
    ) {
      continue;
    }
    const candidate = scan.nodes[position]!;
    if (canCoverPoint(scan, position, target, targetRect, center, options)) {
      return finishFindCoveringNode(scan, targetPosition, candidate);
    }
  }

  return finishFindCoveringNode(scan, targetPosition, null);
}

function canPositionCoverTarget(
  scan: OcclusionScan,
  candidatePosition: number,
  targetPosition: number,
  targetIsAdditionalOverlay: boolean,
  options: SnapshotOcclusionOptions,
): boolean {
  const candidate = scan.nodes[candidatePosition];
  if (!candidate) return false;
  if (candidatePosition > targetPosition) return true;
  if (candidatePosition === targetPosition || targetIsAdditionalOverlay) return false;
  return options.isAdditionalOverlayNode?.(candidate) === true;
}

function finishFindCoveringNode(
  scan: OcclusionScan,
  targetPosition: number,
  result: RawSnapshotNode | null,
): RawSnapshotNode | null {
  scan.coverCache.set(targetPosition, result);
  return result;
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

// Mutation-lane note: the `!positiveRect` guard below is provably redundant
// — a rect-less "candidate" still flows into `findCoveringNode`, whose own
// `!targetRect` check (see the note above it) rejects it the same way.
function isCandidateTouchNode(node: RawSnapshotNode): boolean {
  if (!positiveRect(node.rect)) return false;
  if (node.hittable === true) return true;
  if (isSemanticTouchNode(node)) return true;
  return Boolean(node.label?.trim() || node.value?.trim() || node.identifier?.trim());
}

// Mutation-lane note: this function's own `!positiveRect` guard is likewise
// redundant — a rect-less node that slipped into `overlayPositions` would
// still be excluded downstream by `visibleCoverRect`'s `!candidateRect`
// check, which re-derives the same `positiveRect` over the same pristine
// node.
function isOverlayLikeNode(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  options: SnapshotOcclusionOptions,
): boolean {
  if (!positiveRect(node.rect)) return false;
  if (isViewportRootNode(node)) return false;
  if (isFullViewportChromeContainer(node, byIndex)) return false;
  // This is a presentation-order heuristic: only known floating UI chrome should cover
  // later targets. Generic hittable containers can appear later without being visually on top.
  return (
    nodeKindIncludesAny(node, OVERLAY_KIND_FRAGMENTS) ||
    isAdditionalOverlayRootNode(node, byIndex, options)
  );
}

function isFullViewportChromeContainer(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
): boolean {
  if (!nodeKindIncludesAny(node, VIEWPORT_CHROME_KIND_FRAGMENTS)) return false;
  const rect = positiveRect(node.rect);
  if (!rect) return false;

  let current = typeof node.parentIndex === 'number' ? byIndex.get(node.parentIndex) : undefined;
  const visited = new Set<number>();
  while (current && !visited.has(current.index)) {
    if (isViewportRootNode(current)) {
      const viewportRect = positiveRect(current.rect);
      return Boolean(viewportRect && areRectsApproximatelyEqual(rect, viewportRect));
    }
    visited.add(current.index);
    current =
      typeof current.parentIndex === 'number' ? byIndex.get(current.parentIndex) : undefined;
  }
  return false;
}

function isAdditionalOverlayRootNode(
  node: RawSnapshotNode,
  byIndex: Map<number, RawSnapshotNode>,
  options: SnapshotOcclusionOptions,
): boolean {
  if (options.isAdditionalOverlayNode?.(node) !== true) return false;
  return !hasRenderableAdditionalOverlayAncestor(node, byIndex, options);
}

// Mutation-lane note: `typeof x.parentIndex === 'number' ? byIndex.get(...) :
// undefined` is provably redundant here (and in the structurally identical
// walk in `isSnapshotAncestor` below) — `Map.get` on a key that was never
// set (including `undefined`) already returns `undefined`, the exact value
// the ternary's else-branch produces, so skipping the typeof check changes
// nothing observable.
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

// Mutation-lane note: the `?.` here is provably redundant — this only runs
// once `isAdditionalOverlayRootNode` already confirmed
// `options.isAdditionalOverlayNode` is a real function (its own, unguarded
// `!== true` check would otherwise have returned early), and `options` is
// never replaced mid-walk.
function isRenderableAdditionalOverlayNode(
  node: RawSnapshotNode,
  options: SnapshotOcclusionOptions,
): boolean {
  return (
    options.isAdditionalOverlayNode?.(node) === true &&
    positiveRect(node.rect) !== null &&
    !isViewportRootNode(node)
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

// Mutation-lane note: the `?? ''` fallback's exact replacement text is not
// observable through this module's public API — every caller only checks
// substring membership against a fixed, known fragment list, and no
// plausible filler text coincides with any of them, so no test can
// distinguish `''` from another non-matching filler here without reaching
// into this private function directly.
function normalizeNodeKind(node: Pick<RawSnapshotNode, 'type' | 'role' | 'subrole'>): string {
  return [node.type, node.role, node.subrole].map((value) => normalizeType(value ?? '')).join(' ');
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
