import { AppError, type AppErrorDetails, type ReasonTable } from '@agent-device/kernel/errors';
import { TAP_KEYBOARD_OCCLUDES_TARGET_REASON } from '@agent-device/contracts/tap-keyboard-occlusion';

/** Why a Maestro-compatibility step ends its run. */
const MAESTRO_COMPATIBILITY_REASONS = {
  // A Maestro assertion or condition failed, so the replayed flow does not match the recording.
  testFailure: { reason: 'maestro-test-failure' },
} as const satisfies ReasonTable<'replay'>;

const MAESTRO_TEST_FAILURE_REASON = MAESTRO_COMPATIBILITY_REASONS.testFailure.reason;

export function maestroTestFailure(message: string, details: AppErrorDetails = {}): AppError {
  return new AppError('COMMAND_FAILED', message, {
    ...details,
    reason: MAESTRO_TEST_FAILURE_REASON,
  });
}

export function isMaestroTestFailure(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'COMMAND_FAILED' &&
    (error.details?.reason === MAESTRO_TEST_FAILURE_REASON ||
      (error.details?.reason === TAP_KEYBOARD_OCCLUDES_TARGET_REASON &&
        error.details.dispatched === 'no'))
  );
}
