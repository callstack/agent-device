import {
  AppError,
  type DispatchDisclosure,
  discloseUnclassifiedDispatch,
} from '@agent-device/kernel/errors';
import { resolveCommandRecordingEffect } from '@agent-device/command-registry/registry';
import type { DaemonRequest, DaemonResponse } from '../../daemon-request.ts';

/**
 * The verdict for an interaction failure no producer classified. A request the registry declares
 * read-only (`recordingEffect: 'observes-app'`) never dispatches a mutation, so it is `no`.
 * Otherwise `unknown`: only a producer that refuses before dispatch may say `no`, and only one that
 * proved execution may say `yes`, and this layer cannot tell either from where the failure surfaced.
 * A producer's own verdict is always kept.
 */
export async function discloseUnclassifiedInteractionDispatch(
  req: DaemonRequest,
  dispatch: () => Promise<DaemonResponse | null>,
): Promise<DaemonResponse | null> {
  const verdict: DispatchDisclosure =
    resolveCommandRecordingEffect(req) === 'observes-app' ? 'no' : 'unknown';
  try {
    const response = await dispatch();
    if (!response || response.ok || response.error.details?.dispatched !== undefined) {
      return response;
    }
    return {
      ok: false,
      error: {
        ...response.error,
        details: { ...response.error.details, dispatched: verdict },
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw discloseUnclassifiedDispatch(error, verdict);
    throw error;
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
