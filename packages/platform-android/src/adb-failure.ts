import {
  ANDROID_ADB_TIMEOUT_FAILURE,
  classifyAndroidAdbFailure,
} from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import type { HostCommandResult } from '@agent-device/contracts/platform';

export function androidDiscoveryCommandError(
  message: string,
  result: HostCommandResult,
  fallbackHint: string,
): AppError {
  const failure = classifyAndroidAdbFailure(result.stderr, result.stdout);
  return new AppError('COMMAND_FAILED', message, {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    processExitError: true,
    hint: failure?.hint ?? fallbackHint,
    ...(failure ? { adbFailure: failure.reason } : {}),
    ...(failure?.retriable === undefined ? {} : { retriable: failure.retriable }),
  });
}

export function attachAndroidDiscoveryTimeout<T>(error: T): T {
  if (
    !(error instanceof AppError) ||
    error.code !== 'COMMAND_FAILED' ||
    typeof error.details?.timeoutMs !== 'number'
  ) {
    return error;
  }
  error.details = {
    ...error.details,
    adbFailure: ANDROID_ADB_TIMEOUT_FAILURE.reason,
    ...(typeof error.details.hint === 'string'
      ? {}
      : {
          hint: ANDROID_ADB_TIMEOUT_FAILURE.hint,
        }),
  };
  return error;
}
