import {
  type AppError,
  asAppError,
  detailsAfterDispatchedSteps,
  discloseDispatch,
  type ErrorWireDetails,
} from '@agent-device/kernel/errors';
import { resolveCommandRecordingEffect } from '@agent-device/command-registry/registry';
import type { DaemonRequest, DaemonResponse } from './daemon-request.ts';
import type { RequestDispatchLedger } from './request-dispatch-ledger.ts';

type RecordingEffect = ReturnType<typeof resolveCommandRecordingEffect>;

/**
 * The daemon's verdict around one request. Once the request's ledger holds a returned mutation, its
 * failure is `unknown` with the sent count added to `details.dispatchedSteps`, whatever produced it
 * and whatever the command declares. Before that, the registry's `recordingEffect` decides: a read
 * (`observes-app`) is `no` over any producer verdict, because a resend repeats no app-visible
 * action; a mutation keeps a producer verdict and is `unknown` when no producer classified the
 * failure; a command without a declared effect passes through.
 */
export async function discloseRequestDispatch<Response extends DaemonResponse | null>(
  req: DaemonRequest,
  ledger: RequestDispatchLedger,
  dispatch: () => Promise<Response>,
): Promise<Response> {
  const effect = resolveCommandRecordingEffect(req);
  try {
    const response = await dispatch();
    if (!response || response.ok) return response;
    const details = disclosedDetails(effect, response.error.details, ledger);
    if (details === response.error.details) return response;
    return { ...response, error: { ...response.error, details } };
  } catch (error) {
    const failure = asAppError(error);
    const details = disclosedDetails(effect, failure.details, ledger);
    if (details === failure.details) throw error;
    failure.details = details;
    throw failure;
  }
}

function disclosedDetails(
  effect: RecordingEffect,
  details: ErrorWireDetails | undefined,
  ledger: RequestDispatchLedger,
): ErrorWireDetails | undefined {
  if (ledger.dispatchedSteps > 0)
    return detailsAfterDispatchedSteps(details, ledger.dispatchedSteps);
  if (effect === undefined) return details;
  if (effect === 'observes-app') {
    return details?.dispatched === 'no' ? details : { ...details, dispatched: 'no' };
  }
  return details?.dispatched === undefined ? { ...details, dispatched: 'unknown' } : details;
}

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
