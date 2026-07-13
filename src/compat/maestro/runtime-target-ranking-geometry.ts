import type { TouchReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildSnapshotNodeByIndex,
  findSnapshotAncestor,
  normalizeType,
} from '../../snapshot/snapshot-processing.ts';
import type { MaestroResolvedSnapshotMatch } from './runtime-target-policy.ts';

const RECT_CONTAINS_EPSILON = 1;

export type SnapshotNodeByIndex = ReturnType<typeof buildSnapshotNodeByIndex>;

export function resolveMaestroNodeRect(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  nodeByIndex: SnapshotNodeByIndex,
): { rect: Rect; inherited: boolean } | null {
  if (node.rect && node.rect.width > 0 && node.rect.height > 0) {
    return { rect: node.rect, inherited: false };
  }
  if (node.rect) return null;
  const rect = resolveRectlessNodeAncestorRect(nodes, node, nodeByIndex);
  return rect ? { rect, inherited: true } : null;
}

export function preferOnScreenMatches(
  matches: MaestroResolvedSnapshotMatch[],
  frame: TouchReferenceFrame | undefined,
  requireOnScreen: boolean,
): MaestroResolvedSnapshotMatch[] {
  const onScreen = matches.filter((match) => isRectOnScreen(match.rect, frame));
  if (requireOnScreen) return onScreen;
  return onScreen.length > 0 ? onScreen : matches;
}

export function promoteMaestroSnapshotMatch(
  nodes: SnapshotState['nodes'],
  match: MaestroResolvedSnapshotMatch | null,
  nodeByIndex: SnapshotNodeByIndex,
  promoteTapTarget: boolean,
  frame: TouchReferenceFrame | undefined,
): { node: SnapshotNode; rect: Rect } | null {
  if (!match) return null;
  if (!promoteTapTarget) {
    return { node: match.node, rect: match.rect };
  }
  const ancestor = findMaestroTapAncestor(nodes, match, nodeByIndex, frame);
  return ancestor ?? { node: match.node, rect: match.rect };
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

export function rectContains(container: Rect, child: Rect): boolean {
  return (
    child.x >= container.x - RECT_CONTAINS_EPSILON &&
    child.y >= container.y - RECT_CONTAINS_EPSILON &&
    child.x + child.width <= container.x + container.width + RECT_CONTAINS_EPSILON &&
    child.y + child.height <= container.y + container.height + RECT_CONTAINS_EPSILON
  );
}

export function rectOverlapRatio(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlapArea = Math.max(0, right - left) * Math.max(0, bottom - top);
  return overlapArea / Math.max(1, Math.min(rectArea(a), rectArea(b)));
}

export function verticalOverlapRatio(a: Rect, b: Rect): number {
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const overlap = Math.max(0, bottom - top);
  return overlap / Math.max(1, Math.min(a.height, b.height));
}

function resolveRectlessNodeAncestorRect(
  nodes: SnapshotState['nodes'],
  node: SnapshotNode,
  nodeByIndex: SnapshotNodeByIndex,
): Rect | null {
  let current: SnapshotNode | undefined = node;
  while (typeof current.parentIndex === 'number') {
    current = nodeByIndex.get(current.parentIndex) ?? nodes[current.parentIndex];
    if (!current) return null;
    if (!current.rect) continue;
    return current.rect.width > 0 && current.rect.height > 0 ? current.rect : null;
  }
  return null;
}

function isRectOnScreen(rect: Rect, frame: TouchReferenceFrame | undefined): boolean {
  const maxX = frame?.referenceWidth ?? Number.POSITIVE_INFINITY;
  const maxY = frame?.referenceHeight ?? Number.POSITIVE_INFINITY;
  return rect.x < maxX && rect.y < maxY && rect.x + rect.width > 0 && rect.y + rect.height > 0;
}

function findMaestroTapAncestor(
  nodes: SnapshotState['nodes'],
  match: MaestroResolvedSnapshotMatch,
  nodeByIndex: SnapshotNodeByIndex,
  frame: TouchReferenceFrame | undefined,
): { node: SnapshotNode; rect: Rect } | null {
  if (isActionableMaestroTapTarget(match.node)) return null;
  return findSnapshotAncestor(nodes, match.node, nodeByIndex, (ancestor) => {
    if (!isActionableMaestroTapTarget(ancestor)) return null;
    const ancestorRect = resolveMaestroNodeRect(nodes, ancestor, nodeByIndex);
    if (!ancestorRect || !isUsefulMaestroTapAncestorRect(match.rect, ancestorRect.rect, frame)) {
      return null;
    }
    return { node: ancestor, rect: ancestorRect.rect };
  });
}

function isActionableMaestroTapTarget(node: SnapshotNode): boolean {
  const type = normalizeType(node.type ?? '');
  return (
    node.hittable === true ||
    type === 'button' ||
    type === 'link' ||
    type === 'cell' ||
    type === 'textfield' ||
    type === 'searchfield' ||
    type === 'switch' ||
    type === 'slider'
  );
}

function isUsefulMaestroTapAncestorRect(
  matchRect: Rect,
  ancestorRect: Rect,
  frame: TouchReferenceFrame | undefined,
): boolean {
  if (!rectContains(ancestorRect, matchRect)) return false;
  if (wouldPromoteTabSlotToWholeStrip(matchRect, ancestorRect)) return false;
  const ancestorArea = rectArea(ancestorRect);
  const matchArea = rectArea(matchRect);
  // Keep promotion close to the matched label/id instead of jumping to a broad container.
  if (matchArea > 0 && ancestorArea > matchArea * 30) return false;
  if (frame) {
    const frameArea = frame.referenceWidth * frame.referenceHeight;
    // Full-screen ancestors are usually layout containers, not meaningful tap targets.
    if (frameArea > 0 && ancestorArea > frameArea * 0.5) return false;
  }
  return true;
}

function wouldPromoteTabSlotToWholeStrip(matchRect: Rect, ancestorRect: Rect): boolean {
  if (ancestorRect.height < 32 || ancestorRect.height > 80) return false;
  if (matchRect.height < ancestorRect.height * 0.75) return false;
  if (verticalOverlapRatio(matchRect, ancestorRect) < 0.75) return false;
  if (ancestorRect.width < 240) return false;
  return ancestorRect.width >= matchRect.width * 3;
}
