import { AppError, type AppErrorDetails } from '../../kernel/errors.ts';

const MAESTRO_TEST_FAILURE_REASON = 'maestro-test-failure';

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
    error.details?.reason === MAESTRO_TEST_FAILURE_REASON
  );
}
