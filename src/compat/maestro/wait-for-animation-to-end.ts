import path from 'node:path';
import { AppError } from '../../kernel/errors.ts';
import {
  captureMaestroScreenshot,
  compareMaestroScreenshotFiles,
  throwIfMaestroScreenshotAborted,
  withMaestroScreenshotWorkspace,
} from './maestro-screenshot-comparison.ts';

export type MaestroAnimationWaitOptions = {
  readonly timeoutMs: number;
  readonly now: () => number;
  readonly signal?: AbortSignal;
  readonly capture: (path: string) => Promise<void>;
};

/**
 * Matches Maestro's screenshot-based animation wait: two captures are taken
 * back-to-back and the operation retries immediately while the timeout remains.
 */
export async function waitForMaestroAnimationToEnd(
  options: MaestroAnimationWaitOptions,
): Promise<boolean> {
  validateTimeout(options.timeoutMs);
  throwIfMaestroScreenshotAborted(options.signal);

  const deadline = options.now() + options.timeoutMs;
  return await withMaestroScreenshotWorkspace('animation', async (tempRoot) => {
    const firstPath = path.join(tempRoot, 'first.png');
    const secondPath = path.join(tempRoot, 'second.png');
    while (true) {
      throwIfMaestroScreenshotAborted(options.signal);
      if (await capturePairMatches(options, firstPath, secondPath)) return true;
      if (options.now() >= deadline) return false;
    }
  });
}

async function capturePairMatches(
  options: MaestroAnimationWaitOptions,
  firstPath: string,
  secondPath: string,
): Promise<boolean> {
  const captures = [
    await captureMaestroScreenshot(options, firstPath),
    await captureMaestroScreenshot(options, secondPath),
  ];
  if (!captures[0] || !captures[1]) return false;
  return (
    (await compareMaestroScreenshotFiles(firstPath, secondPath, options.signal, 'animation')) ===
    true
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
