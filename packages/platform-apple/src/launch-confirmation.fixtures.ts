import { ALERT_NOT_FOUND_RUNNER_CODE } from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';

/** The prompt a session app's own launch URL raises. */
export const CONFIRMATION = { message: 'Open in “Example App”?', items: ['Cancel', 'Open'] };

/** The runner's typed absence: `alert get` looked once and found no alert. */
export function alertNotFound(): AppError {
  return new AppError('COMMAND_FAILED', 'alert not found', {
    runnerErrorCode: ALERT_NOT_FOUND_RUNNER_CODE,
  });
}
