import { asAppError, AppError } from '@agent-device/kernel/errors';
import { INTERACTION_ERROR_REASONS } from '@agent-device/contracts/interaction-error';
import {
  absenceCaptureOptionMessage,
  type AbsenceCaptureOption,
  type AbsenceObservation,
} from './absence-observation.ts';

export function absenceCaptureOptionError(option: AbsenceCaptureOption): AppError {
  return new AppError('INVALID_ARGS', absenceCaptureOptionMessage(option), {
    command: 'is',
    predicate: 'absent',
    rejectedOption: option,
  });
}

export function absenceObservationError(
  selector: string,
  observation: AbsenceObservation,
): AppError {
  const firstMatch = 'firstMatch' in observation ? observation.firstMatch : undefined;
  const details = {
    command: 'is',
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
      `is absent failed for selector ${selector}: ${observation.matches} match${multiple ? 'es' : ''} found`,
      {
        ...details,
        ...(multiple ? { hint: 'Refine the selector to match no elements.' } : {}),
      },
    );
  }
  return new AppError(
    'COMMAND_FAILED',
    `is absent could not prove absence for selector ${selector}: ${
      observation.kind === 'sparse' ? 'capture was sparse' : 'capture was truncated'
    }`,
    {
      ...details,
      hint: 'Retry after the accessibility capture is complete.',
    },
  );
}

export function absenceUnreadableError(selector: string, error: unknown): AppError {
  const cause = asAppError(error);
  return new AppError(
    'COMMAND_FAILED',
    `is absent could not prove absence for selector ${selector}: capture was unreadable`,
    {
      command: 'is',
      reason: INTERACTION_ERROR_REASONS.predicateFailed,
      predicate: 'absent',
      selector,
      matches: 0,
      observation: 'unreadable',
      captureErrorCode: cause.code,
      ...(typeof cause.details?.reason === 'string'
        ? { captureErrorReason: cause.details.reason }
        : {}),
      hint: 'Retry after the accessibility capture is readable.',
    },
    cause,
  );
}
