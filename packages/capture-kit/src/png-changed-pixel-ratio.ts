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
 */
export function computePngChangedPixelRatio(
  first: PngRgbImage,
  second: PngRgbImage,
): PngChangedPixelRatioResult {
  if (first.width !== second.width || first.height !== second.height) {
    return { status: 'dimension_mismatch' };
  }

  const totalPixels = first.width * first.height;
  if (totalPixels === 0) return { status: 'compared', changedPixelRatio: 0 };
  if (first.data.length !== second.data.length) {
    return { status: 'dimension_mismatch' };
  }

  let changedPixels = 0;
  for (let offset = 0; offset + 3 < first.data.length; offset += 4) {
    if (
      first.data[offset] !== second.data[offset] ||
      first.data[offset + 1] !== second.data[offset + 1] ||
      first.data[offset + 2] !== second.data[offset + 2]
    ) {
      changedPixels += 1;
    }
  }

  return { status: 'compared', changedPixelRatio: changedPixels / totalPixels };
}
