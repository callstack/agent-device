import { formatHumanErrorLines } from '@agent-device/command-output';
import type { AppError, NormalizedError } from '@agent-device/kernel/errors';

export function printHumanError(
  err: AppError | NormalizedError,
  options: { showDetails?: boolean } = {},
): void {
  for (const line of formatHumanErrorLines(err, options)) {
    process.stderr.write(`${line}\n`);
  }
}
