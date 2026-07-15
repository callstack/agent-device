import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestCanceledError, isRequestCanceledError } from '../../request/cancel.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { computePngRgbDifferenceAsync } from '../../utils/png-worker-client.ts';
import type { PngRgbDifferenceResult } from '../../utils/png-rgb-difference.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';

export type MaestroScreenshotBaseline = {
  readonly matchesCurrent: () => Promise<boolean | undefined>;
};

type MaestroScreenshotCaptureOptions = {
  readonly signal?: AbortSignal;
  readonly capture: (path: string) => Promise<void>;
};

export async function withMaestroScreenshotBaseline<T>(options: {
  readonly signal?: AbortSignal;
  readonly capture: (path: string) => Promise<void>;
  readonly run: (baseline: MaestroScreenshotBaseline) => Promise<T>;
}): Promise<T> {
  return await withMaestroScreenshotWorkspace('tap', async (tempRoot) => {
    const beforePath = path.join(tempRoot, 'before.png');
    const afterPath = path.join(tempRoot, 'after.png');
    const baselineAvailable = await captureMaestroScreenshot(options, beforePath);
    return await options.run({
      matchesCurrent: async () => {
        if (!baselineAvailable || !(await captureMaestroScreenshot(options, afterPath))) {
          return undefined;
        }
        return await compareMaestroScreenshotFiles(beforePath, afterPath, options.signal, 'tap');
      },
    });
  });
}

export async function withMaestroScreenshotWorkspace<T>(
  purpose: 'animation' | 'tap',
  run: (tempRoot: string) => Promise<T>,
): Promise<T> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `agent-device-maestro-${purpose}-`));
  try {
    return await run(tempRoot);
  } finally {
    try {
      await fs.rm(tempRoot, { recursive: true, force: true });
    } catch {}
  }
}

export async function compareMaestroScreenshotFiles(
  firstPath: string,
  secondPath: string,
  signal: AbortSignal | undefined,
  purpose: 'animation' | 'tap',
): Promise<boolean | undefined> {
  try {
    const [firstBuffer, secondBuffer] = await Promise.all([
      fs.readFile(firstPath),
      fs.readFile(secondPath),
    ]);
    throwIfMaestroScreenshotAborted(signal);
    const comparison = await computePngRgbDifferenceAsync(
      firstBuffer,
      secondBuffer,
      'Maestro screenshot',
    );
    throwIfMaestroScreenshotAborted(signal);
    return screenshotsMatch(comparison, purpose);
  } catch (error) {
    rethrowCancellation(error, signal);
    emitDiagnostic({
      level: 'debug',
      phase: 'maestro_screenshot_compare',
      data: {
        purpose,
        result: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return undefined;
  }
}

export async function captureMaestroScreenshot(
  options: MaestroScreenshotCaptureOptions,
  screenshotPath: string,
): Promise<boolean> {
  try {
    await fs.rm(screenshotPath, { force: true });
    throwIfMaestroScreenshotAborted(options.signal);
    await options.capture(screenshotPath);
    throwIfMaestroScreenshotAborted(options.signal);
    return true;
  } catch (error) {
    rethrowCancellation(error, options.signal);
    return false;
  }
}

function screenshotsMatch(
  comparison: PngRgbDifferenceResult,
  purpose: 'animation' | 'tap',
): boolean {
  if (comparison.status !== 'compared') {
    emitComparison(purpose, comparison.status, comparison);
    return false;
  }
  const differencePercent = comparison.differencePercent;
  const matches =
    differencePercent <=
    MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndDifferencePercent;
  emitComparison(purpose, matches ? 'stable' : 'changed', comparison);
  return matches;
}

function emitComparison(
  purpose: 'animation' | 'tap',
  result: 'stable' | 'changed' | 'dimension_mismatch' | 'data_length_mismatch',
  comparison: PngRgbDifferenceResult,
): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'maestro_screenshot_compare',
    data: {
      purpose,
      result,
      first: comparison.first,
      second: comparison.second,
      ...('differencePercent' in comparison
        ? { differencePercent: comparison.differencePercent }
        : {}),
    },
  });
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted || isRequestCanceledError(error)) throw createRequestCanceledError();
}

export function throwIfMaestroScreenshotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}
