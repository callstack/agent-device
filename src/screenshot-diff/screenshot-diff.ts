import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { Rect } from '@agent-device/kernel/snapshot';
import { PNG } from '@agent-device/capture-kit/png';
import {
  computeScreenshotDiffPixelsAsync,
  decodePngAsync,
  encodePngAsync,
} from '@agent-device/capture-kit/png-worker-client';
import { annotateDiffRegions } from './screenshot-diff-region-overlay.ts';
import { summarizeDiffRegions, type ScreenshotDiffRegion } from './screenshot-diff-regions.ts';
import type { ImageDimensions } from '@agent-device/kernel/screenshot-geometry';

export type ScreenshotDimensionMismatch = {
  expected: ImageDimensions;
  actual: ImageDimensions;
};

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

export type ScreenshotDiffResult = {
  diffPath?: string;
  totalPixels: number;
  differentPixels: number;
  mismatchPercentage: number;
  match: boolean;
  dimensionMismatch?: ScreenshotDimensionMismatch;
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
const COLOR_DISTANCE_SCALE = 255 * Math.sqrt(3);

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
    decodePngAsync(baselineBuffer, 'baseline screenshot'),
    decodePngAsync(currentBuffer, 'current screenshot'),
  ]);
  validateMaxPixels(baseline.width, baseline.height, 'baseline screenshot', options.maxPixels);
  validateMaxPixels(current.width, current.height, 'current screenshot', options.maxPixels);

  const threshold = options.threshold ?? 0.1;

  // Handle dimension mismatch — no diff image can be generated for different-sized images
  if (baseline.width !== current.width || baseline.height !== current.height) {
    const totalPixels = baseline.width * baseline.height;
    await removeStaleDiffOutput(options.outputPath);
    return {
      match: false,
      mismatchPercentage: 100,
      totalPixels,
      differentPixels: totalPixels,
      dimensionMismatch: {
        expected: { width: baseline.width, height: baseline.height },
        actual: { width: current.width, height: current.height },
      },
    };
  }

  const totalPixels = baseline.width * baseline.height;
  const maxColorDistance = threshold * COLOR_DISTANCE_SCALE;
  // Per-pixel comparison is CPU-heavy for full-resolution screenshots, so it
  // runs on the PNG worker thread (with an in-process synchronous fallback).
  const { diffData, diffMask, differentPixels } = await computeScreenshotDiffPixelsAsync({
    baselineData: baseline.data,
    currentData: current.data,
    width: baseline.width,
    height: baseline.height,
    maxColorDistance,
  });

  const regions =
    differentPixels > 0
      ? summarizeDiffRegions({
          diffMask,
          baseline,
          current,
          totalPixels,
          differentPixels,
        })
      : [];

  if (differentPixels > 0 && diffOutputPath) {
    const diff = new PNG({ width: baseline.width, height: baseline.height });
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

function validateMaxPixels(
  width: number,
  height: number,
  label: string,
  maxPixels: number | undefined,
): void {
  if (maxPixels == null || maxPixels <= 0) return;
  const totalPixels = width * height;
  if (totalPixels <= maxPixels) return;
  throw new AppError(
    'INVALID_ARGS',
    `${label} is ${totalPixels} pixels, which exceeds the configured maxImagePixels limit of ${maxPixels}`,
  );
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
