import {
  asAppError,
  detailsAfterDispatchedSteps,
  discloseDispatch,
  discloseDispatchAfterSteps,
  discloseUnclassifiedDispatch,
  type ErrorWireDetails,
} from '@agent-device/kernel/errors';
import { resolveCommandRecordingEffect } from '@agent-device/command-registry/registry';
import type { DaemonRequest, DaemonResponse } from './daemon-request.ts';

/**
 * The device-reaching mutations of one request whose send returned. Once one did, no later failure
 * of that request may claim `dispatched: no`, whatever observation or sub-step produced it.
 */
export type RequestDispatchLedger = { dispatchedSteps: number };

export function createRequestDispatchLedger(): RequestDispatchLedger {
  return { dispatchedSteps: 0 };
}

/** Sends one mutation and records it in the request's ledger once the send returned. */
export async function sendRecordedMutation<Result>(
  ledger: RequestDispatchLedger | undefined,
  send: () => Promise<Result>,
): Promise<Result> {
  const result = await send();
  if (ledger) ledger.dispatchedSteps += 1;
  return result;
}

/**
 * The daemon's verdict around one request, keyed by the registry's `recordingEffect`. A read
 * (`observes-app`) is `no` over any producer verdict: it has no side effect, so a resend is safe.
 * Otherwise a producer verdict stands until a mutation of this request was sent, after which the
 * failure is `unknown` with the sent count in `details.dispatchedSteps`; `unknown` fills a failure
 * no producer classified. A command without a declared effect passes through.
 */
export async function discloseRequestDispatch(
  req: DaemonRequest,
  ledger: RequestDispatchLedger,
  dispatch: () => Promise<DaemonResponse | null>,
): Promise<DaemonResponse | null> {
  const effect = resolveCommandRecordingEffect(req);
  try {
    const response = await dispatch();
    if (!response || response.ok || effect === undefined) return response;
    const details = disclosedDetails(effect, response.error.details, ledger);
    if (details === response.error.details) return response;
    return { ok: false, error: { ...response.error, details } };
  } catch (error) {
    if (effect === undefined) throw error;
    const failure = asAppError(error);
    if (effect === 'observes-app') throw discloseDispatch(failure, 'no');
    discloseDispatchAfterSteps(failure, ledger.dispatchedSteps);
    throw discloseUnclassifiedDispatch(failure, 'unknown');
  }
}

function disclosedDetails(
  effect: NonNullable<ReturnType<typeof resolveCommandRecordingEffect>>,
  details: ErrorWireDetails | undefined,
  ledger: RequestDispatchLedger,
): ErrorWireDetails | undefined {
  if (effect === 'observes-app') {
    return details?.dispatched === 'no' ? details : { ...details, dispatched: 'no' };
  }
  const afterSteps = detailsAfterDispatchedSteps(details, ledger.dispatchedSteps);
  if (afterSteps?.dispatched !== undefined) return afterSteps;
  return { ...afterSteps, dispatched: 'unknown' };
}
