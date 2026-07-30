import type { Rect } from '@agent-device/kernel/snapshot';
import { normalizedRect, type NormalizedRect } from '../utils/screenshot-geometry.ts';
import { findConnectedMaskComponents } from './screenshot-diff-components.ts';
import { splitLargeDiffRegions } from './screenshot-diff-region-split.ts';
import type { MutableDiffRegion } from './screenshot-diff-region-types.ts';

export type ScreenshotDiffRegion = {
  index: number;
  rect: Rect;
  normalizedRect: NormalizedRect;
  differentPixels: number;
  shareOfDiffPercentage: number;
  currentOverlayMatches?: ScreenshotDiffRegionOverlayMatch[];
};

export type ScreenshotDiffRegionOverlayMatch = {
  ref: string;
  label?: string;
  regionCoveragePercentage: number;
  rect: Rect;
};

const DEFAULT_MAX_DIFF_REGIONS = 8;
const REGION_MERGE_GAP_PX = 12;
const MAX_REGIONS_TO_MERGE = 2000;
export function summarizeDiffRegions(params: {
  diffMask: Uint8Array;
  width: number;
  height: number;
  differentPixels: number;
}): ScreenshotDiffRegion[] {
  const rawRegions = findConnectedDiffRegions(params);
  // Avoid quadratic nearby-merge work on extremely noisy diffs; the later ranking
  // still keeps the largest components, but tiny speckles may remain unmerged.
  const mergedRegions =
    rawRegions.length <= MAX_REGIONS_TO_MERGE
      ? mergeNearbyRegions(rawRegions, REGION_MERGE_GAP_PX)
      : rawRegions;
  const splitRegions = splitLargeDiffRegions(mergedRegions, params);
  return splitRegions
    .sort((left, right) => {
      const pixelDelta = right.differentPixels - left.differentPixels;
      if (pixelDelta !== 0) return pixelDelta;
      const topDelta = left.minY - right.minY;
      if (topDelta !== 0) return topDelta;
      return left.minX - right.minX;
    })
    .slice(0, DEFAULT_MAX_DIFF_REGIONS)
    .map((region, index) =>
      toScreenshotDiffRegion(region, index + 1, {
        width: params.width,
        height: params.height,
        differentPixels: params.differentPixels,
      }),
    );
}

function findConnectedDiffRegions(params: {
  diffMask: Uint8Array;
  width: number;
  height: number;
}): MutableDiffRegion[] {
  const { diffMask, width, height } = params;
  return findConnectedMaskComponents({
    mask: diffMask,
    width,
    height,
    hooks: {
      create: (pixelIndex) => createDiffRegion(pixelIndex, width),
      visit: (region, pixelIndex) => addPixelToRegion(region, pixelIndex, width),
    },
  });
}

function createDiffRegion(pixelIndex: number, width: number): MutableDiffRegion {
  const startX = pixelIndex % width;
  const startY = Math.floor(pixelIndex / width);
  return {
    minX: startX,
    minY: startY,
    maxX: startX,
    maxY: startY,
    differentPixels: 0,
  };
}

function addPixelToRegion(region: MutableDiffRegion, pixelIndex: number, width: number): void {
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  region.minX = Math.min(region.minX, x);
  region.minY = Math.min(region.minY, y);
  region.maxX = Math.max(region.maxX, x);
  region.maxY = Math.max(region.maxY, y);
  region.differentPixels += 1;
}

function mergeNearbyRegions(regions: MutableDiffRegion[], gapPx: number): MutableDiffRegion[] {
  const merged: MutableDiffRegion[] = [];
  for (const region of regions.sort((left, right) => {
    const topDelta = left.minY - right.minY;
    if (topDelta !== 0) return topDelta;
    return left.minX - right.minX;
  })) {
    const existing = merged.find((candidate) => regionsAreNear(candidate, region, gapPx));
    if (!existing) {
      merged.push({ ...region });
      continue;
    }
    mergeRegionInto(existing, region);
  }
  return merged;
}

function regionsAreNear(left: MutableDiffRegion, right: MutableDiffRegion, gapPx: number): boolean {
  return (
    left.minX - gapPx <= right.maxX &&
    right.minX - gapPx <= left.maxX &&
    left.minY - gapPx <= right.maxY &&
    right.minY - gapPx <= left.maxY
  );
}

function mergeRegionInto(target: MutableDiffRegion, source: MutableDiffRegion): void {
  target.minX = Math.min(target.minX, source.minX);
  target.minY = Math.min(target.minY, source.minY);
  target.maxX = Math.max(target.maxX, source.maxX);
  target.maxY = Math.max(target.maxY, source.maxY);
  target.differentPixels += source.differentPixels;
}

function toScreenshotDiffRegion(
  region: MutableDiffRegion,
  index: number,
  image: { width: number; height: number; differentPixels: number },
): ScreenshotDiffRegion {
  const rect = {
    x: region.minX,
    y: region.minY,
    width: region.maxX - region.minX + 1,
    height: region.maxY - region.minY + 1,
  };
  return {
    index,
    rect,
    normalizedRect: normalizedRect({
      x: roundPercentage(rect.x / image.width),
      y: roundPercentage(rect.y / image.height),
      width: roundPercentage(rect.width / image.width),
      height: roundPercentage(rect.height / image.height),
    }),
    differentPixels: region.differentPixels,
    shareOfDiffPercentage: roundPercentage(region.differentPixels / image.differentPixels),
  };
}

function roundPercentage(ratio: number): number {
  return Math.round(ratio * 100 * 100) / 100;
}
