export type PngRgbImage = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
};

type PngRgbComparisonMetadata = {
  readonly first: { readonly width: number; readonly height: number; readonly dataLength: number };
  readonly second: { readonly width: number; readonly height: number; readonly dataLength: number };
};

export type PngRgbDifferenceResult = PngRgbComparisonMetadata &
  (
    | { readonly status: 'compared'; readonly differencePercent: number }
    | { readonly status: 'dimension_mismatch' | 'data_length_mismatch' }
  );

/** Computes Maestro's normalized absolute RGB difference for two decoded PNGs. */
export function computePngRgbDifference(
  first: PngRgbImage,
  second: PngRgbImage,
): PngRgbDifferenceResult {
  const metadata = {
    first: { width: first.width, height: first.height, dataLength: first.data.length },
    second: { width: second.width, height: second.height, dataLength: second.data.length },
  };
  if (first.width !== second.width || first.height !== second.height) {
    return { ...metadata, status: 'dimension_mismatch' };
  }

  const totalPixels = first.width * first.height;
  if (first.data.length !== second.data.length || first.data.length !== totalPixels * 4) {
    return { ...metadata, status: 'data_length_mismatch' };
  }

  let absoluteRgbDifference = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    absoluteRgbDifference += Math.abs(first.data[index]! - second.data[index]!);
    absoluteRgbDifference += Math.abs(first.data[index + 1]! - second.data[index + 1]!);
    absoluteRgbDifference += Math.abs(first.data[index + 2]! - second.data[index + 2]!);
  }

  return {
    ...metadata,
    status: 'compared',
    differencePercent: (100 * absoluteRgbDifference) / (3 * 255 * totalPixels),
  };
}
