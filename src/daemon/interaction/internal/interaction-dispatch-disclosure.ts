import { type AppError, asAppError, discloseDispatch } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '../../daemon-request.ts';

/** A failure response built before any dispatch: the requested operation never reached the device. */
export function refusedBeforeDispatch<Response extends DaemonResponse>(
  response: Response,
): Response {
  if (response.ok) return response;
  return {
    ...response,
    error: { ...response.error, details: { ...response.error.details, dispatched: 'no' } },
  };
}

/** A failure thrown before any dispatch: the requested operation never reached the device. */
export function thrownBeforeDispatch(error: unknown): AppError {
  return discloseDispatch(asAppError(error), 'no');
}
