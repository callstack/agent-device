import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { PNG } from './png.ts';
import {
  computeScreenshotDiffPixelsAsync,
  decodeScreenshotImageAsync,
  encodePngAsync,
} from './png-worker-client.ts';
import { annotateDiffRegions } from './screenshot-diff-region-overlay.ts';
import { summarizeDiffRegions, type ScreenshotDiffRegion } from './screenshot-diff-regions.ts';
import type { ImageDimensions } from '@agent-device/kernel/screenshot-geometry';

type ScreenshotOcrSummary = {
  provider: 'tesseract';
  baselineBlocks: number;
  currentBlocks: number;
  matches: Array<{
    text: string;
    baselineRect: Rect;
    currentRect: Rect;
    delta: Rect;
    confidence: number;
    possibleTextMetricMismatch: boolean;
  }>;
  movementClusters?: Array<{
    texts: string[];
    xRange: { min: number; max: number };
    yRange: { min: number; max: number };
  }>;
};

type ScreenshotNonTextDelta = {
  index: number;
  regionIndex?: number;
  slot: 'leading' | 'trailing' | 'background' | 'separator' | 'unknown';
  likelyKind: 'icon' | 'toggle' | 'chevron' | 'separator' | 'visual';
  rect: Rect;
  nearestText?: string;
};

export type ScreenshotDiffNormalization = {
  baseline: ImageDimensions;
  current: ImageDimensions;
  scaledCurrent: ImageDimensions;
  compared: ImageDimensions;
  currentScale: { x: number; y: number };
  alignment: 'top-left';
  coordinateSpace: 'comparison-pixels';
};

export type ScreenshotDiffResult = {
  diffPath?: string;
  totalPixels: number;
  differentPixels: number;
  mismatchPercentage: number;
  match: boolean;
  /** Present when input dimensions differ. Regions and their ref rectangles use comparison pixels. */
  normalization?: ScreenshotDiffNormalization;
  regions?: ScreenshotDiffRegion[];
  currentOverlayPath?: string;
  currentOverlayRefCount?: number;
  /** @deprecated Retained for source compatibility; OCR analysis is no longer emitted. */
  ocr?: ScreenshotOcrSummary;
  /** @deprecated Retained for source compatibility; non-text analysis is no longer emitted. */
  nonTextDeltas?: ScreenshotNonTextDelta[];
};

export type ScreenshotDiffOptions = {
  threshold?: number;
  outputPath?: string;
  maxPixels?: number;
};

// Each pixel is a point in 3D RGB space (R, G, B each 0–255).
// The maximum possible distance between two colors is from black (0,0,0) to
// white (255,255,255): √(255² + 255² + 255²) = 255√3 ≈ 441.67.
// We use this as the denominator so threshold 0–1 maps linearly to the full
// color distance range: 0 = exact match only, 1 = everything matches.
// Match the per-pixel square-root rounding so the maximum stays inclusive.
const COLOR_DISTANCE_SCALE = Math.sqrt(3 * 255 ** 2);

/**
 * Compares two screenshots pixel by pixel. Each input may be PNG or JPEG: the container is sniffed
 * from the bytes rather than the file name, so a baseline exported by any tool that writes JPEG
 * still compares. The diff image itself is always PNG.
 */
export async function compareScreenshots(
  baselinePath: string,
  currentPath: string,
  options: ScreenshotDiffOptions = {},
): Promise<ScreenshotDiffResult> {
  await validateFileExists(baselinePath, 'Baseline image not found');
  await validateFileExists(currentPath, 'Current screenshot not found');

  const diffOutputPath = options.outputPath;

  const [baselineBuffer, currentBuffer] = await Promise.all([
    fs.readFile(baselinePath),
    fs.readFile(currentPath),
  ]);

  const [baseline, current] = await Promise.all([
    decodeScreenshotImageAsync(baselineBuffer, 'baseline screenshot', options.maxPixels),
    decodeScreenshotImageAsync(currentBuffer, 'current screenshot', options.maxPixels),
  ]);
  const normalization = screenshotDiffNormalization(baseline, current);
  const compared = normalization?.compared ?? baseline;
  const { validateScreenshotPixels } = await import('./screenshot-image-size.ts');
  validateScreenshotPixels(compared.width, compared.height, 'comparison canvas', options.maxPixels);
  let scaledCurrent = current;
  if (normalization && current.width !== baseline.width) {
    const { resizePngBox } = await import('./png-resize.ts');
    scaledCurrent = resizePngBox(
      current,
      normalization.scaledCurrent.width,
      normalization.scaledCurrent.height,
    );
  }
  const alignedBaseline = padScreenshotHeight(baseline, compared.height);
  const alignedCurrent = padScreenshotHeight(scaledCurrent, compared.height);
  const overlapHeight = Math.min(baseline.height, scaledCurrent.height);
  const threshold = options.threshold ?? 0.1;
  const totalPixels = compared.width * compared.height;
  const maxColorDistance = threshold * COLOR_DISTANCE_SCALE;
  // Per-pixel comparison is CPU-heavy for full-resolution screenshots, so it
  // runs on the PNG worker thread (with an in-process synchronous fallback).
  const { diffData, diffMask, differentPixels } = await computeScreenshotDiffPixelsAsync({
    baselineData: alignedBaseline.data,
    currentData: alignedCurrent.data,
    width: compared.width,
    height: compared.height,
    overlapHeight,
    maxColorDistance,
  });

  const regions =
    differentPixels > 0
      ? summarizeDiffRegions({
          diffMask,
          baseline: alignedBaseline,
          current: alignedCurrent,
          totalPixels,
          differentPixels,
        })
      : [];

  if (differentPixels > 0 && diffOutputPath) {
    const diff = new PNG({ width: compared.width, height: compared.height });
    diff.data = diffData;
    annotateDiffRegions(diff, regions);
    await fs.mkdir(path.dirname(diffOutputPath), { recursive: true });
    await fs.writeFile(diffOutputPath, await encodePngAsync(diff));
  } else {
    await removeStaleDiffOutput(options.outputPath);
  }

  // Round to 2 decimal places: multiply percentage by 100 before rounding,
  // then divide back. e.g. 0.12345 → 12.345% → round(1234.5)/100 → 12.35%
  const mismatchPercentage =
    totalPixels > 0 ? Math.round((differentPixels / totalPixels) * 100 * 100) / 100 : 0;

  return {
    ...(differentPixels > 0 && diffOutputPath ? { diffPath: diffOutputPath } : {}),
    ...(regions.length > 0 ? { regions } : {}),
    ...(normalization ? { normalization } : {}),
    totalPixels,
    differentPixels,
    mismatchPercentage,
    match: differentPixels === 0,
  };
}

async function validateFileExists(filePath: string, errorMessage: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new AppError('INVALID_ARGS', `${errorMessage}: ${filePath}`);
  }
}

function screenshotDiffNormalization(
  baseline: PNG,
  current: PNG,
): ScreenshotDiffNormalization | undefined {
  if (baseline.width === current.width && baseline.height === current.height) return undefined;
  const scaledHeight = Math.max(1, Math.round(current.height * (baseline.width / current.width)));
  return {
    baseline: { width: baseline.width, height: baseline.height },
    current: { width: current.width, height: current.height },
    scaledCurrent: { width: baseline.width, height: scaledHeight },
    compared: { width: baseline.width, height: Math.max(baseline.height, scaledHeight) },
    currentScale: { x: baseline.width / current.width, y: scaledHeight / current.height },
    alignment: 'top-left',
    coordinateSpace: 'comparison-pixels',
  };
}

function padScreenshotHeight(image: PNG, height: number): PNG {
  if (image.height === height) return image;
  const padded = new PNG({ width: image.width, height });
  image.data.copy(padded.data);
  return padded;
}

async function removeStaleDiffOutput(outputPath: string | undefined): Promise<void> {
  if (!outputPath) return;
  try {
    await fs.unlink(outputPath);
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) throw error;
  }
}

function isFsError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
