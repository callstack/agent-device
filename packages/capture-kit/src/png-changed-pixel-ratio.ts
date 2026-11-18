import type { PngRgbImage } from './png-rgb-difference.ts';

export type { PngRgbImage };

export type PngChangedPixelRatioResult =
  | { readonly status: 'compared'; readonly changedPixelRatio: number }
  | { readonly status: 'dimension_mismatch' };

/**
 * The share of pixels whose color moved at all between two decoded PNGs.
 *
 * A pixel counts as changed when any of its RGB channels differs, ignoring alpha, so a
 * translucent-layer fade that leaves the composite untouched is not reported. This is a
 * coverage metric, not a magnitude one: `computePngRgbDifference` answers how far the colors
 * moved, and this answers how much of the frame moved. A recording that only shifts a 1 px
 * progress line scores a ratio near zero either way.
 *
 * Dimensions must match. Callers comparing frames of different sizes are asking a different
 * question, and returning a made-up ratio would hide it.
 *
 * `ignoreTopHeightShare` cuts the top share of the frame out of the comparison entirely, for
 * bands whose pixels move without the dispatch causing it — the device's own status bar ticks
 * between the bracket's frames, and the readback must answer for what the dispatch changed, not
 * for the wall clock. The ratio runs over the compared region: both the changed count and the
 * denominator count the rows below the band, so the share is the share of the region the pair
 * was actually compared over.
 */
export function computePngChangedPixelRatio(
  first: PngRgbImage,
  second: PngRgbImage,
  options: Readonly<{ ignoreTopHeightShare?: number }> = {},
): PngChangedPixelRatioResult {
  if (first.width !== second.width || first.height !== second.height) {
    return { status: 'dimension_mismatch' };
  }

  const totalPixels = first.width * first.height;
  if (totalPixels === 0) return { status: 'compared', changedPixelRatio: 0 };
  if (first.data.length !== second.data.length) {
    return { status: 'dimension_mismatch' };
  }

  // Rows at or above the cut are outside the compared region on both sides.
  const ignoredRows =
    options.ignoreTopHeightShare && options.ignoreTopHeightShare > 0
      ? Math.min(first.height, Math.floor(first.height * options.ignoreTopHeightShare))
      : 0;
  const comparedPixels = totalPixels - ignoredRows * first.width;
  if (comparedPixels <= 0) return { status: 'compared', changedPixelRatio: 0 };

  return {
    status: 'compared',
    changedPixelRatio: countChangedPixels(first, second, ignoredRows) / comparedPixels,
  };
}

/** Counts pixels whose RGB differs outside the ignored top rows. */
function countChangedPixels(first: PngRgbImage, second: PngRgbImage, ignoredRows: number): number {
  const declaredBytes = first.width * first.height * 4;
  let changedPixels = 0;
  for (
    let offset = ignoredRows * first.width * 4;
    offset + 3 < declaredBytes && offset + 3 < first.data.length;
    offset += 4
  ) {
    if (
      first.data[offset] !== second.data[offset] ||
      first.data[offset + 1] !== second.data[offset + 1] ||
      first.data[offset + 2] !== second.data[offset + 2]
    ) {
      changedPixels += 1;
    }
  }
  return changedPixels;
}
