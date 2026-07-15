import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestCanceledError, isRequestCanceledError } from '../../request/cancel.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { decodePngAsync } from '../../utils/png-worker-client.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';

type DecodedScreenshot = Awaited<ReturnType<typeof decodePngAsync>>;

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
    const [first, second] = await Promise.all([
      decodePngAsync(firstBuffer, 'Maestro screenshot'),
      decodePngAsync(secondBuffer, 'Maestro screenshot'),
    ]);
    throwIfMaestroScreenshotAborted(signal);
    return screenshotsMatch(first, second, purpose);
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
  first: DecodedScreenshot,
  second: DecodedScreenshot,
  purpose: 'animation' | 'tap',
): boolean {
  if (first.width !== second.width || first.height !== second.height) {
    emitComparison(purpose, 'dimension_mismatch', first, second);
    return false;
  }
  const totalPixels = first.width * first.height;
  if (first.data.length !== second.data.length || first.data.length !== totalPixels * 4) {
    emitComparison(purpose, 'data_length_mismatch', first, second);
    return false;
  }

  let absoluteRgbDifference = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    absoluteRgbDifference += Math.abs(first.data[index]! - second.data[index]!);
    absoluteRgbDifference += Math.abs(first.data[index + 1]! - second.data[index + 1]!);
    absoluteRgbDifference += Math.abs(first.data[index + 2]! - second.data[index + 2]!);
  }

  const differencePercent = (100 * absoluteRgbDifference) / (3 * 255 * totalPixels);
  const matches =
    differencePercent <=
    MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndDifferencePercent;
  emitComparison(purpose, matches ? 'stable' : 'changed', first, second, differencePercent);
  return matches;
}

function emitComparison(
  purpose: 'animation' | 'tap',
  result: 'stable' | 'changed' | 'dimension_mismatch' | 'data_length_mismatch',
  first: DecodedScreenshot,
  second: DecodedScreenshot,
  differencePercent?: number,
): void {
  emitDiagnostic({
    level: 'debug',
    phase: 'maestro_screenshot_compare',
    data: {
      purpose,
      result,
      first: { width: first.width, height: first.height, dataLength: first.data.length },
      second: { width: second.width, height: second.height, dataLength: second.data.length },
      ...(differencePercent === undefined ? {} : { differencePercent }),
    },
  });
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted || isRequestCanceledError(error)) throw createRequestCanceledError();
}

export function throwIfMaestroScreenshotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}
