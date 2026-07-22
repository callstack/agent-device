import type { PNG } from '../utils/png.ts';
import type { Rect } from '../kernel/snapshot.ts';
import { normalizedRect, type NormalizedRect } from '../utils/screenshot-geometry.ts';
import { findConnectedMaskComponents } from './screenshot-diff-components.ts';
import { splitLargeDiffRegions } from './screenshot-diff-region-split.ts';
import type { MutableDiffRegion } from './screenshot-diff-region-types.ts';

type ScreenshotDiffColor = {
  r: number;
  g: number;
  b: number;
};

export type ScreenshotDiffRegion = {
  index: number;
  rect: Rect;
  normalizedRect: NormalizedRect;
  differentPixels: number;
  shareOfDiffPercentage: number;
  densityPercentage: number;
  shape: 'compact' | 'horizontal-band' | 'vertical-band' | 'large-area';
  size: 'small' | 'medium' | 'large';
  location: string;
  averageBaselineColorHex: string;
  averageCurrentColorHex: string;
  baselineLuminance: number;
  currentLuminance: number;
  dominantChange: 'brighter' | 'darker' | 'color-shift' | 'mixed';
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
// These region labels are coarse, screen-relative buckets for agent guidance,
// not tuned to a specific screenshot size or app layout.
const DOMINANT_CHANGE_MIN_CHANNEL_DELTA = 12;
const LARGE_AREA_MIN_WIDTH_RATIO = 0.55;
const LARGE_AREA_MIN_HEIGHT_RATIO = 0.12;
const BAND_MIN_ASPECT_RATIO = 2.5;
const LARGE_REGION_MIN_AREA_RATIO = 0.04;
const MEDIUM_REGION_MIN_AREA_RATIO = 0.01;

export function summarizeDiffRegions(params: {
  diffMask: Uint8Array;
  baseline: PNG;
  current: PNG;
  totalPixels: number;
  differentPixels: number;
  maxRegions?: number;
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
    .slice(0, Math.max(0, params.maxRegions ?? DEFAULT_MAX_DIFF_REGIONS))
    .map((region, index) =>
      toScreenshotDiffRegion(region, index + 1, {
        width: params.baseline.width,
        height: params.baseline.height,
        totalPixels: params.totalPixels,
        differentPixels: params.differentPixels,
      }),
    );
}

function findConnectedDiffRegions(params: {
  diffMask: Uint8Array;
  baseline: PNG;
  current: PNG;
}): MutableDiffRegion[] {
  const { diffMask, baseline, current } = params;
  const { width, height } = baseline;
  return findConnectedMaskComponents({
    mask: diffMask,
    width,
    height,
    hooks: {
      create: (pixelIndex) => createDiffRegion(pixelIndex, width),
      visit: (region, pixelIndex) => addPixelToRegion(region, pixelIndex, width, baseline, current),
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
    baselineRed: 0,
    baselineGreen: 0,
    baselineBlue: 0,
    currentRed: 0,
    currentGreen: 0,
    currentBlue: 0,
  };
}

function addPixelToRegion(
  region: MutableDiffRegion,
  pixelIndex: number,
  width: number,
  baseline: PNG,
  current: PNG,
): void {
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  const dataIndex = pixelIndex * 4;
  region.minX = Math.min(region.minX, x);
  region.minY = Math.min(region.minY, y);
  region.maxX = Math.max(region.maxX, x);
  region.maxY = Math.max(region.maxY, y);
  region.differentPixels += 1;
  region.baselineRed += baseline.data[dataIndex]!;
  region.baselineGreen += baseline.data[dataIndex + 1]!;
  region.baselineBlue += baseline.data[dataIndex + 2]!;
  region.currentRed += current.data[dataIndex]!;
  region.currentGreen += current.data[dataIndex + 1]!;
  region.currentBlue += current.data[dataIndex + 2]!;
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
  target.baselineRed += source.baselineRed;
  target.baselineGreen += source.baselineGreen;
  target.baselineBlue += source.baselineBlue;
  target.currentRed += source.currentRed;
  target.currentGreen += source.currentGreen;
  target.currentBlue += source.currentBlue;
}

function toScreenshotDiffRegion(
  region: MutableDiffRegion,
  index: number,
  image: { width: number; height: number; totalPixels: number; differentPixels: number },
): ScreenshotDiffRegion {
  const rect = {
    x: region.minX,
    y: region.minY,
    width: region.maxX - region.minX + 1,
    height: region.maxY - region.minY + 1,
  };
  const center = {
    x: Math.round(region.minX + rect.width / 2),
    y: Math.round(region.minY + rect.height / 2),
  };
  const averageBaselineColor = averageRegionColor(
    region.baselineRed,
    region.baselineGreen,
    region.baselineBlue,
    region.differentPixels,
  );
  const averageCurrentColor = averageRegionColor(
    region.currentRed,
    region.currentGreen,
    region.currentBlue,
    region.differentPixels,
  );
  const regionArea = rect.width * rect.height;
  const densityPercentage = roundPercentage(region.differentPixels / regionArea);
  const baselineLuminance = Math.round(luminance(averageBaselineColor));
  const currentLuminance = Math.round(luminance(averageCurrentColor));
  const shape = describeRegionShape(rect, image.width, image.height);
  const size = describeRegionSize(regionArea, image.totalPixels);
  const dominantChange = describeDominantChange(averageBaselineColor, averageCurrentColor);
  const location = describeRegionLocation(center, image.width, image.height);
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
    densityPercentage,
    shape,
    size,
    location,
    averageBaselineColorHex: toHexColor(averageBaselineColor),
    averageCurrentColorHex: toHexColor(averageCurrentColor),
    baselineLuminance,
    currentLuminance,
    dominantChange,
  };
}

function averageRegionColor(
  red: number,
  green: number,
  blue: number,
  pixels: number,
): ScreenshotDiffColor {
  return {
    r: Math.round(red / pixels),
    g: Math.round(green / pixels),
    b: Math.round(blue / pixels),
  };
}

function describeRegionLocation(
  center: { x: number; y: number },
  width: number,
  height: number,
): string {
  const horizontal =
    center.x < width / 3 ? 'left' : center.x > (width * 2) / 3 ? 'right' : 'center';
  const vertical =
    center.y < height / 3 ? 'top' : center.y > (height * 2) / 3 ? 'bottom' : 'middle';
  return horizontal === 'center' && vertical === 'middle' ? 'center' : `${vertical}-${horizontal}`;
}

function describeDominantChange(
  baseline: ScreenshotDiffColor,
  current: ScreenshotDiffColor,
): ScreenshotDiffRegion['dominantChange'] {
  const baselineLuminance = luminance(baseline);
  const currentLuminance = luminance(current);
  const luminanceDelta = currentLuminance - baselineLuminance;
  if (Math.abs(luminanceDelta) >= DOMINANT_CHANGE_MIN_CHANNEL_DELTA) {
    return luminanceDelta > 0 ? 'brighter' : 'darker';
  }

  const maxChannelDelta = Math.max(
    Math.abs(current.r - baseline.r),
    Math.abs(current.g - baseline.g),
    Math.abs(current.b - baseline.b),
  );
  return maxChannelDelta >= DOMINANT_CHANGE_MIN_CHANNEL_DELTA ? 'color-shift' : 'mixed';
}

function describeRegionShape(
  rect: { width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): ScreenshotDiffRegion['shape'] {
  if (
    rect.width >= imageWidth * LARGE_AREA_MIN_WIDTH_RATIO &&
    rect.height >= imageHeight * LARGE_AREA_MIN_HEIGHT_RATIO
  ) {
    return 'large-area';
  }
  if (rect.width >= rect.height * BAND_MIN_ASPECT_RATIO) return 'horizontal-band';
  if (rect.height >= rect.width * BAND_MIN_ASPECT_RATIO) return 'vertical-band';
  return 'compact';
}

function describeRegionSize(regionArea: number, totalPixels: number): ScreenshotDiffRegion['size'] {
  const areaRatio = regionArea / totalPixels;
  if (areaRatio >= LARGE_REGION_MIN_AREA_RATIO) return 'large';
  if (areaRatio >= MEDIUM_REGION_MIN_AREA_RATIO) return 'medium';
  return 'small';
}

function luminance(color: ScreenshotDiffColor): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

function toHexColor(color: ScreenshotDiffColor): string {
  return `#${toHexChannel(color.r)}${toHexChannel(color.g)}${toHexChannel(color.b)}`;
}

function toHexChannel(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function roundPercentage(ratio: number): number {
  return Math.round(ratio * 100 * 100) / 100;
}
