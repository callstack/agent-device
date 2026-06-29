import { AppError, toAppErrorCode } from './kernel/errors.ts';
import type { DaemonError } from './contracts.ts';

export function throwDaemonError(error: DaemonError): never {
  throw new AppError(toAppErrorCode(error.code), error.message, {
    ...(error.details ?? {}),
    hint: error.hint,
    diagnosticId: error.diagnosticId,
    logPath: error.logPath,
  });
}
