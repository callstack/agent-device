import { isPositiveFiniteRect } from '@agent-device/kernel/rect';
import type { Rect } from '@agent-device/kernel/snapshot';
import type { AndroidSnapshotPresentationBudget } from './snapshot-presentation.ts';

type Interval = { start: number; end: number };
type SweepRect = Rect & { endX: number };

/** Fraction of the covered rects' union that lies under the covering rects' union. */
export function unionCoverage(
  coveringRects: readonly Rect[],
  coveredRects: readonly Rect[],
  presentationBudget?: AndroidSnapshotPresentationBudget,
): number {
  presentationBudget?.consume(coveringRects.length + coveredRects.length);
  const covered = sweepRects(coveredRects);
  if (covered.length === 0) return 0;

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const rect of covered) {
    minX = Math.min(minX, rect.x);
    maxX = Math.max(maxX, rect.endX);
  }
  const covering = sweepRects(coveringRects).filter((rect) => rect.x < maxX && rect.endX > minX);
  if (covering.length === 0) return 0;

  const xEdges = [
    ...covered.flatMap((rect) => [rect.x, rect.endX]),
    ...covering.flatMap((rect) => [Math.max(rect.x, minX), Math.min(rect.endX, maxX)]),
  ];
  presentationBudget?.consume(covered.length + covering.length + xEdges.length);
  covered.sort(compareRectsByX);
  covering.sort(compareRectsByX);
  const xs = [...new Set(xEdges)].sort((left, right) => left - right);

  let activeCovered: SweepRect[] = [];
  let activeCovering: SweepRect[] = [];
  let nextCovered = 0;
  let nextCovering = 0;
  let coveredArea = 0;
  let overlapArea = 0;

  for (let index = 0; index < xs.length - 1; index += 1) {
    const x = xs[index]!;
    const nextX = xs[index + 1]!;

    activeCovered = activeCovered.filter((rect) => rect.endX > x);
    activeCovering = activeCovering.filter((rect) => rect.endX > x);
    while (nextCovered < covered.length && covered[nextCovered]!.x <= x) {
      activeCovered.push(covered[nextCovered]!);
      nextCovered += 1;
    }
    while (nextCovering < covering.length && covering[nextCovering]!.x <= x) {
      activeCovering.push(covering[nextCovering]!);
      nextCovering += 1;
    }

    presentationBudget?.consume(1 + activeCovered.length + activeCovering.length);
    const coveredY = mergeYIntervals(activeCovered);
    const coveringY = mergeYIntervals(activeCovering);
    const width = nextX - x;
    coveredArea += width * totalLength(coveredY);
    overlapArea += width * intersectionLength(coveredY, coveringY);
  }

  return coveredArea <= 0 ? 0 : overlapArea / coveredArea;
}

function sweepRects(rects: readonly Rect[]): SweepRect[] {
  return rects.filter(isPositiveFiniteRect).map((rect) => ({ ...rect, endX: rect.x + rect.width }));
}

function compareRectsByX(left: SweepRect, right: SweepRect): number {
  return left.x - right.x || left.endX - right.endX;
}

function mergeYIntervals(rects: readonly Rect[]): Interval[] {
  const intervals = rects
    .map((rect) => ({ start: rect.y, end: rect.y + rect.height }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Interval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (!previous || interval.start > previous.end) {
      merged.push({ ...interval });
    } else {
      previous.end = Math.max(previous.end, interval.end);
    }
  }
  return merged;
}

function totalLength(intervals: readonly Interval[]): number {
  return intervals.reduce((total, interval) => total + interval.end - interval.start, 0);
}

function intersectionLength(left: readonly Interval[], right: readonly Interval[]): number {
  let total = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftInterval = left[leftIndex]!;
    const rightInterval = right[rightIndex]!;
    total += Math.max(
      0,
      Math.min(leftInterval.end, rightInterval.end) -
        Math.max(leftInterval.start, rightInterval.start),
    );
    if (leftInterval.end <= rightInterval.end) leftIndex += 1;
    else rightIndex += 1;
  }
  return total;
}
