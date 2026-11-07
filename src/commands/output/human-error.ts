import { formatHumanError } from '@agent-device/command-output';
import type { AppError, NormalizedError } from '@agent-device/kernel/errors';

export type PrintHumanErrorOptions = {
  /** The `--debug`/`--verbose` tier: adds the raw details dump. */
  debugTier?: boolean;
  /** The failing command's synopsis for an INVALID_ARGS Next step. */
  synopsis?: string;
  /** Evidence printed after the error body, such as the `--debug` log tail. */
  trailer?: string;
};

/**
 * Writes a failure to stderr. The summary line opens the block and, when anything follows
 * it, closes it too: callers that merge streams and keep only the first or the last line
 * still read the code, the message, the dispatch fact and the Next step.
 */
export function printHumanError(
  err: AppError | NormalizedError,
  options: PrintHumanErrorOptions = {},
): void {
  const { summary, body } = formatHumanError(err, {
    showDetails: options.debugTier,
    synopsis: options.synopsis,
  });
  const lines = [summary, ...body, ...(options.trailer ? [options.trailer] : [])];
  if (lines.length > 1) lines.push(summary);
  for (const line of lines) {
    process.stderr.write(`${line}\n`);
  }
}
