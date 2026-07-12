import type { Rect, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import {
  buildSnapshotNodeByIndex,
  isDescendantOfSnapshotNode,
  normalizeType,
} from '../../snapshot/snapshot-processing.ts';
import {
  maestroVisibleTextMatchRank,
  type MaestroResolvedSnapshotMatch,
} from './runtime-target-policy.ts';
import {
  rectContains,
  verticalOverlapRatio,
  type SnapshotNodeByIndex,
} from './runtime-target-ranking-geometry.ts';

export function inferMaestroMissingTabSlotMatch(
  nodes: SnapshotState['nodes'],
  match: MaestroResolvedSnapshotMatch,
  query: string,
): MaestroResolvedSnapshotMatch | null {
  if (!isMaestroTabStripContainerMatch(match, query)) return null;
  const children = collectMaestroTabStripChildCandidates(
    nodes,
    match,
    query,
    buildSnapshotNodeByIndex(nodes),
  );
  if (children.length === 0) return null;
  const medianChildWidth = median(children.map((child) => child.rect.width));
  const allGaps = resolveHorizontalGaps(
    match.rect,
    children.map((child) => child.rect),
  );
  const gap = selectMaestroMissingSlotGap(match, query, allGaps, medianChildWidth);
  if (!gap) return null;
  return matchWithRect(match, gap);
}

function collectMaestroTabStripChildCandidates(
  nodes: SnapshotState['nodes'],
  match: MaestroResolvedSnapshotMatch,
  query: string,
  nodeByIndex: SnapshotNodeByIndex,
): Array<SnapshotNode & { rect: Rect }> {
  return nodes
    .filter((node): node is SnapshotNode & { rect: Rect } => {
      return (
        node.index !== match.node.index &&
        Boolean(node.rect) &&
        isDescendantOfSnapshotNode(nodes, node, match.node, nodeByIndex) &&
        isMaestroTabStripChildCandidate(node as SnapshotNode & { rect: Rect }, match.rect, query)
      );
    })
    .sort((left, right) => left.rect.x - right.rect.x);
}

function selectMaestroMissingSlotGap(
  match: MaestroResolvedSnapshotMatch,
  query: string,
  gaps: Array<{ x: number; width: number }>,
  medianChildWidth: number,
): { x: number; width: number } | null {
  const plausibleGaps = gaps.filter((gap) =>
    isPlausibleMissingTabSlot(gap.width, medianChildWidth),
  );
  const leadingTextSlot = inferMaestroLeadingTextSlotGap(match, query, gaps);
  const hasPlausibleLeadingGap = plausibleGaps.some((gap) => isLeadingGap(match.rect, gap));
  if (leadingTextSlot && !hasPlausibleLeadingGap) return leadingTextSlot;
  if (plausibleGaps.length === 1) return plausibleGaps[0] ?? null;
  return leadingTextSlot;
}

function inferMaestroLeadingTextSlotGap(
  match: MaestroResolvedSnapshotMatch,
  query: string,
  gaps: Array<{ x: number; width: number }>,
): { x: number; width: number } | null {
  const leadingGap = gaps.find((gap) => Math.abs(gap.x - match.rect.x) < 1);
  const estimatedLabelWidth = Math.max(48, Math.min(220, query.length * 8 + 24));
  if (!isLeadingTextSlotCandidate(match, query, leadingGap, estimatedLabelWidth)) return null;
  return {
    x: match.rect.x,
    width: Math.min(estimatedLabelWidth, leadingGap.width),
  };
}

function isLeadingTextSlotCandidate(
  match: MaestroResolvedSnapshotMatch,
  query: string,
  gap: { x: number; width: number } | undefined,
  estimatedLabelWidth: number,
): gap is { x: number; width: number } {
  if (!gap) return false;
  return (
    normalizeType(match.node.type ?? '') === 'scrollview' &&
    maestroVisibleTextMatchRank(match.node, query) <= 1 &&
    match.rect.width >= 240 &&
    match.rect.height >= 32 &&
    match.rect.height <= 80 &&
    gap.width <= match.rect.width * 0.55 &&
    gap.width >= estimatedLabelWidth * 0.6
  );
}

function isLeadingGap(rect: Rect, gap: { x: number; width: number }): boolean {
  return Math.abs(gap.x - rect.x) < 1;
}

function matchWithRect(
  match: MaestroResolvedSnapshotMatch,
  gap: { x: number; width: number },
): MaestroResolvedSnapshotMatch {
  return {
    ...match,
    rect: {
      x: gap.x,
      y: match.rect.y,
      width: gap.width,
      height: match.rect.height,
    },
  };
}

function isMaestroTabStripContainerMatch(
  match: MaestroResolvedSnapshotMatch,
  query: string,
): boolean {
  const type = normalizeType(match.node.type ?? '');
  if (type !== 'cell' && type !== 'other' && type !== 'scrollview' && type !== 'scroll-area') {
    return false;
  }
  if (match.rect.width < 120 || match.rect.height < 32 || match.rect.height > 80) return false;
  return maestroVisibleTextMatchRank(match.node, query) <= 1;
}

function isMaestroTabStripChildCandidate(
  node: SnapshotNode & { rect: Rect },
  container: Rect,
  query: string,
): boolean {
  const type = normalizeType(node.type ?? '');
  if (type !== 'button' && type !== 'cell' && type !== 'other') return false;
  if (maestroVisibleTextMatchRank(node, query) <= 1) return false;
  if (node.rect.width < 16 || node.rect.height < 16) return false;
  if (!rectContains(container, node.rect)) return false;
  return verticalOverlapRatio(container, node.rect) >= 0.5;
}

function resolveHorizontalGaps(
  container: Rect,
  occupied: Rect[],
): Array<{ x: number; width: number }> {
  const gaps: Array<{ x: number; width: number }> = [];
  let cursor = container.x;
  const containerRight = container.x + container.width;
  for (const rect of occupied) {
    const start = Math.max(container.x, rect.x);
    const end = Math.min(containerRight, rect.x + rect.width);
    if (start > cursor) gaps.push({ x: cursor, width: start - cursor });
    cursor = Math.max(cursor, end);
  }
  if (containerRight > cursor) gaps.push({ x: cursor, width: containerRight - cursor });
  return gaps;
}

function isPlausibleMissingTabSlot(gapWidth: number, medianChildWidth: number): boolean {
  if (gapWidth < 24 || medianChildWidth < 24) return false;
  return gapWidth >= medianChildWidth * 0.4 && gapWidth <= medianChildWidth * 1.6;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? 0;
}
