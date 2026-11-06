import { formatHumanErrorLines } from '@agent-device/command-output';
import type { AppError, NormalizedError } from '@agent-device/kernel/errors';

/**
 * The CLI's debug tier (`--debug`/`--verbose`) owns both the raw details dump
 * and the diagnostics footer; the default tier keeps a failure's stderr head
 * the error itself, so a reader that keeps the tail of a merged stream cannot
 * trade the error body for a path.
 */
export function printHumanError(
  err: AppError | NormalizedError,
  options: { debugTier?: boolean } = {},
): void {
  const tier = { showDetails: options.debugTier, footer: options.debugTier };
  for (const line of formatHumanErrorLines(err, tier)) {
    process.stderr.write(`${line}\n`);
  }
}
