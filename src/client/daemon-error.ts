import { AppError, toAppErrorCode } from '@agent-device/kernel/errors';
import type { DaemonError } from '@agent-device/kernel/contracts';

export function throwDaemonError(error: DaemonError): never {
  throw new AppError(toAppErrorCode(error.code), error.message, {
    ...(error.details ?? {}),
    hint: error.hint,
    diagnosticId: error.diagnosticId,
    logPath: error.logPath,
    retriable: error.retriable,
    supportedOn: error.supportedOn,
  });
}
