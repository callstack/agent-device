import { readResponseWarnings } from '@agent-device/kernel/success-text';

/**
 * Response-level warnings accumulate: every `open` producer adds its own note and keeps the ones
 * already there, so a producer never has to know which other note ran first.
 */
export function appendResponseWarning(
  responseData: Record<string, unknown>,
  warning: string,
): void {
  responseData.warnings = [...readResponseWarnings(responseData), warning];
}
