import type { PngRgbImage } from './png-rgb-difference.ts';

export type { PngRgbImage };

/** Smallest box holding every pixel that moved past the region tolerance, in image coordinates. */
export type PngChangedRegion = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PngChangedPixelsResult =
  | {
      readonly status: 'compared';
      readonly changedPixelRatio: number;
      readonly region: PngChangedRegion | null;
    }
  | { readonly status: 'dimension_mismatch' };

/**
 * Region tolerance in max RGB channel delta.
 *
 * Encoded video never holds a still frame bit-exact, so counting every differing pixel would report
 * a region covering 82-100% of a clip whose visible change was one row of a list. Measured on iOS
 * simulator recordings at this sheet's comparison width, noise stays under a delta of 16 while a
 * rendered control moves far more than that; a wider tolerance starts discarding real edges.
 */
const CHANGED_REGION_TOLERANCE = 16;

/**
 * How much of a frame moved between two decoded PNGs, and where.
 *
 * The two answers use two criteria on purpose. The share counts a pixel as changed when any RGB
 * channel differs at all, ignoring alpha: that is the coverage question a sheet asks when deciding
 * whether a frame earned a cell, and it is deliberately sensitive. The region only spans pixels
 * that moved past {@link CHANGED_REGION_TOLERANCE}, because a box that answers "where" has to
 * survive encoder noise; a box over every differing pixel is the whole frame and says nothing.
 *
 * `computePngRgbDifference` answers how far the colors moved. A recording that only shifts a 1 px
 * progress line scores a share near zero either way.
 *
 * Dimensions must match. Callers comparing frames of different sizes are asking a different
 * question, and returning a made-up answer would hide it.
 */
export function computePngChangedPixels(
  first: PngRgbImage,
  second: PngRgbImage,
  tolerance: number = CHANGED_REGION_TOLERANCE,
): PngChangedPixelsResult {
  if (first.width !== second.width || first.height !== second.height) {
    return { status: 'dimension_mismatch' };
  }

  const totalPixels = first.width * first.height;
  if (totalPixels === 0) return { status: 'compared', changedPixelRatio: 0, region: null };
  if (first.data.length !== second.data.length) {
    return { status: 'dimension_mismatch' };
  }

  return {
    status: 'compared',
    changedPixelRatio: countChangedPixels(first, second) / totalPixels,
    region: changedRegionBetween(first, second, tolerance),
  };
}

function countChangedPixels(first: PngRgbImage, second: PngRgbImage): number {
  let changedPixels = 0;
  for (let offset = 0; offset + 3 < first.data.length; offset += 4) {
    if (largestChannelDelta(first, second, offset) > 0) changedPixels += 1;
  }
  return changedPixels;
}

function changedRegionBetween(
  first: PngRgbImage,
  second: PngRgbImage,
  tolerance: number,
): PngChangedRegion | null {
  let minX = 0;
  let minY = 0;
  let maxX = -1;
  let maxY = -1;
  let pixel = 0;
  for (let offset = 0; offset + 3 < first.data.length; offset += 4, pixel += 1) {
    if (largestChannelDelta(first, second, offset) <= tolerance) continue;
    const x = pixel % first.width;
    const y = Math.floor(pixel / first.width);
    if (maxX < 0) {
      minX = x;
      minY = y;
    }
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function largestChannelDelta(first: PngRgbImage, second: PngRgbImage, offset: number): number {
  return Math.max(
    Math.abs(first.data[offset]! - second.data[offset]!),
    Math.abs(first.data[offset + 1]! - second.data[offset + 1]!),
    Math.abs(first.data[offset + 2]! - second.data[offset + 2]!),
  );
}
