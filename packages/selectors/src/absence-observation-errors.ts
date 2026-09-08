import { asAppError, AppError } from '@agent-device/kernel/errors';
import { INTERACTION_ERROR_REASONS } from './interaction-error.ts';
import {
  absenceCaptureOptionMessage,
  type AbsenceCaptureOption,
  type AbsenceObservation,
} from './absence-observation.ts';

export function absenceCaptureOptionError(
  option: AbsenceCaptureOption,
  command: 'is' | 'wait' = 'is',
): AppError {
  return new AppError('INVALID_ARGS', absenceCaptureOptionMessage(option, command), {
    command,
    predicate: 'absent',
    rejectedOption: option,
  });
}

export function absenceObservationError(
  selector: string,
  observation: AbsenceObservation,
  command: 'is' | 'wait' = 'is',
): AppError {
  const firstMatch = 'firstMatch' in observation ? observation.firstMatch : undefined;
  const details = {
    command,
    reason: INTERACTION_ERROR_REASONS.predicateFailed,
    predicate: 'absent',
    selector,
    matches: observation.matches,
    observation: observation.kind,
    ...(firstMatch ? { firstMatch } : {}),
    ...(observation.kind === 'sparse' ? { snapshotQuality: observation.quality } : {}),
    ...(observation.kind === 'truncated' ? { truncated: true } : {}),
  };
  if (observation.kind === 'present') {
    const multiple = observation.matches > 1;
    return new AppError(
      'COMMAND_FAILED',
      `${command} absent failed for selector ${selector}: ${observation.matches} match${multiple ? 'es' : ''} found`,
      {
        ...details,
        ...(multiple ? { hint: 'Refine the selector to match no elements.' } : {}),
      },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `${command} absent could not prove absence for selector ${selector}: ${
      observation.kind === 'sparse' ? 'capture was sparse' : 'capture was truncated'
    }`,
    {
      ...details,
      hint: 'Retry after the accessibility capture is complete.',
    },
  );
}

export function absenceUnreadableError(
  selector: string,
  error: unknown,
  command: 'is' | 'wait' = 'is',
): AppError {
  const cause = asAppError(error);
  const captureErrorReason =
    typeof cause.details?.reason === 'string'
      ? cause.details.reason
      : typeof cause.details?.androidSnapshotHelperFailureReason === 'string'
        ? cause.details.androidSnapshotHelperFailureReason
        : undefined;
  return new AppError(
    'COMMAND_FAILED',
    `${command} absent could not prove absence for selector ${selector}: capture was unreadable`,
    {
      command,
      reason: INTERACTION_ERROR_REASONS.predicateFailed,
      predicate: 'absent',
      selector,
      matches: 0,
      observation: 'unreadable',
      captureErrorCode: cause.code,
      ...(captureErrorReason ? { captureErrorReason } : {}),
      hint: 'Retry after the accessibility capture is readable.',
    },
    cause,
  );
}
