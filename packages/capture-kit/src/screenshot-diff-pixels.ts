const DIFF_CONTEXT_LIGHTEN_RATIO = 0.72;
const DIFF_CHANGE_TINT_RATIO = 0.78;
const DIFF_CHANGE_COLOR = { r: 220, g: 0, b: 0 } as const;

export type ScreenshotDiffPixelsJob = {
  width: number;
  height: number;
  baselineData: Uint8Array;
  currentData: Uint8Array;
  maxColorDistance: number;
};

export type ScreenshotDiffPixelsResult = {
  diffData: Buffer;
  diffMask: Uint8Array;
  differentPixels: number;
};

/**
 * Pure per-pixel screenshot comparison. CPU-heavy for multi-megapixel
 * screenshots, so daemon callers run it through the PNG worker thread
 * (`png-worker-client.ts`) instead of calling it on the event loop.
 */
export function computeScreenshotDiffPixels(
  job: ScreenshotDiffPixelsJob,
): ScreenshotDiffPixelsResult {
  const { baselineData, currentData, maxColorDistance } = job;
  const totalPixels = job.width * job.height;
  const diffData = Buffer.alloc(totalPixels * 4);
  const diffMask = new Uint8Array(totalPixels);
  let differentPixels = 0;

  // PNG data is a flat RGBA buffer: [R, G, B, A, R, G, B, A, ...].
  // We step by 4 to visit each pixel and compute its Euclidean distance
  // in RGB space between the baseline and current image.
  for (let index = 0, pixelIndex = 0; index < baselineData.length; index += 4, pixelIndex += 1) {
    const redDelta = baselineData[index]! - currentData[index]!;
    const greenDelta = baselineData[index + 1]! - currentData[index + 1]!;
    const blueDelta = baselineData[index + 2]! - currentData[index + 2]!;
    const colorDistance = Math.sqrt(redDelta ** 2 + greenDelta ** 2 + blueDelta ** 2);

    if (colorDistance > maxColorDistance) {
      differentPixels += 1;
      diffMask[pixelIndex] = 1;
      const context = renderDiffContextChannel(currentData, index);
      diffData[index] = tintChannel(context, DIFF_CHANGE_COLOR.r, DIFF_CHANGE_TINT_RATIO);
      diffData[index + 1] = tintChannel(context, DIFF_CHANGE_COLOR.g, DIFF_CHANGE_TINT_RATIO);
      diffData[index + 2] = tintChannel(context, DIFF_CHANGE_COLOR.b, DIFF_CHANGE_TINT_RATIO);
      diffData[index + 3] = 255;
      continue;
    }

    const context = renderDiffContextChannel(currentData, index);
    diffData[index] = context;
    diffData[index + 1] = context;
    diffData[index + 2] = context;
    diffData[index + 3] = 255;
  }

  return { diffData, diffMask, differentPixels };
}

function renderDiffContextChannel(sourceData: Uint8Array, index: number): number {
  const gray = Math.round(
    sourceData[index]! * 0.299 + sourceData[index + 1]! * 0.587 + sourceData[index + 2]! * 0.114,
  );
  return tintChannel(gray, 255, DIFF_CONTEXT_LIGHTEN_RATIO);
}

function tintChannel(base: number, tint: number, ratio: number): number {
  return Math.round(base * (1 - ratio) + tint * ratio);
}
