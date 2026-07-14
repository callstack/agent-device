import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestCanceledError, isRequestCanceledError } from '../../request/cancel.ts';
import { AppError } from '../../kernel/errors.ts';
import { decodePngAsync } from '../../utils/png-worker-client.ts';
import { MAESTRO_COMPATIBILITY_PRESETS } from './compatibility-policy.ts';

export type MaestroAnimationWaitOptions = {
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly capture: (path: string) => Promise<void>;
};

type DecodedScreenshot = Awaited<ReturnType<typeof decodePngAsync>>;

/**
 * Matches Maestro's screenshot-based animation wait: two captures are taken
 * back-to-back and the operation retries immediately while the timeout remains.
 */
export async function waitForMaestroAnimationToEnd(
  options: MaestroAnimationWaitOptions,
): Promise<void> {
  validateTimeout(options.timeoutMs);
  throwIfAborted(options.signal);

  const deadline = options.now() + options.timeoutMs;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-maestro-animation-'));
  const firstPath = path.join(tempRoot, 'first.png');
  const secondPath = path.join(tempRoot, 'second.png');

  try {
    while (true) {
      throwIfAborted(options.signal);
      if (await capturePairMatches(options, firstPath, secondPath)) return;
      if (options.now() >= deadline) return;
    }
  } finally {
    await removeTempRoot(tempRoot);
  }
}

async function capturePairMatches(
  options: MaestroAnimationWaitOptions,
  firstPath: string,
  secondPath: string,
): Promise<boolean> {
  const captures = [
    await captureScreenshot(options, firstPath),
    await captureScreenshot(options, secondPath),
  ];
  if (!captures[0] || !captures[1]) return false;

  try {
    const [firstBuffer, secondBuffer] = await Promise.all([
      fs.readFile(firstPath),
      fs.readFile(secondPath),
    ]);
    throwIfAborted(options.signal);
    const [first, second] = await Promise.all([
      decodePngAsync(firstBuffer, 'Maestro animation screenshot'),
      decodePngAsync(secondBuffer, 'Maestro animation screenshot'),
    ]);
    throwIfAborted(options.signal);
    return screenshotsMatch(first, second);
  } catch (error) {
    rethrowCancellation(error, options.signal);
    return false;
  }
}

async function captureScreenshot(
  options: MaestroAnimationWaitOptions,
  screenshotPath: string,
): Promise<boolean> {
  try {
    await fs.rm(screenshotPath, { force: true });
    throwIfAborted(options.signal);
    await options.capture(screenshotPath);
    throwIfAborted(options.signal);
    return true;
  } catch (error) {
    rethrowCancellation(error, options.signal);
    return false;
  }
}

function screenshotsMatch(first: DecodedScreenshot, second: DecodedScreenshot): boolean {
  if (first.width !== second.width || first.height !== second.height) return false;
  const totalPixels = first.width * first.height;
  if (first.data.length !== second.data.length || first.data.length !== totalPixels * 4) {
    return false;
  }

  let absoluteRgbDifference = 0;
  for (let index = 0; index < first.data.length; index += 4) {
    absoluteRgbDifference += Math.abs(first.data[index]! - second.data[index]!);
    absoluteRgbDifference += Math.abs(first.data[index + 1]! - second.data[index + 1]!);
    absoluteRgbDifference += Math.abs(first.data[index + 2]! - second.data[index + 2]!);
  }

  const differencePercent = (100 * absoluteRgbDifference) / (3 * 255 * totalPixels);
  return (
    differencePercent <=
    MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndDifferencePercent
  );
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new AppError(
      'INVALID_ARGS',
      'waitForAnimationToEnd timeout must be a non-negative number.',
    );
  }
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  if (signal?.aborted || isRequestCanceledError(error)) throw createRequestCanceledError();
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}

async function removeTempRoot(tempRoot: string): Promise<void> {
  try {
    await fs.rm(tempRoot, { recursive: true, force: true });
  } catch {}
}
