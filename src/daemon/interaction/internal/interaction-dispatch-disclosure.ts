import {
  AppError,
  discloseDispatch,
  discloseUnclassifiedDispatch,
} from '@agent-device/kernel/errors';
import { resolveCommandRecordingEffect } from '@agent-device/command-registry/registry';
import type { DaemonRequest, DaemonResponse } from '../../daemon-request.ts';

/**
 * The daemon's verdict around interaction dispatch. A request the registry declares read-only
 * (`recordingEffect: 'observes-app'`) is `no` over any producer verdict: a read has no side effect,
 * so it is always safe to resend. Otherwise `unknown` fills only a failure no producer classified.
 */
export async function discloseInteractionDispatch(
  req: DaemonRequest,
  dispatch: () => Promise<DaemonResponse | null>,
): Promise<DaemonResponse | null> {
  const readOnly = resolveCommandRecordingEffect(req) === 'observes-app';
  try {
    const response = await dispatch();
    if (!response || response.ok) return response;
    const producerVerdict = response.error.details?.dispatched;
    const dispatched = readOnly ? 'no' : (producerVerdict ?? 'unknown');
    if (dispatched === producerVerdict) return response;
    return {
      ok: false,
      error: { ...response.error, details: { ...response.error.details, dispatched } },
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    throw readOnly ? discloseDispatch(error, 'no') : discloseUnclassifiedDispatch(error, 'unknown');
  }
}

/** A failure response built before any dispatch: the requested operation never reached the device. */
export function refusedBeforeDispatch(response: DaemonResponse): DaemonResponse {
  if (response.ok) return response;
  return {
    ok: false,
    error: { ...response.error, details: { ...response.error.details, dispatched: 'no' } },
  };
}
