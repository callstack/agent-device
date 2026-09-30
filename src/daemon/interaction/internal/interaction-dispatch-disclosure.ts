import { AppError, discloseUnclassifiedDispatch } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '../../daemon-request.ts';

/**
 * The verdict for an interaction failure no producer classified: `unknown`. Only a producer that
 * refuses before dispatch may say `no`, and only one that proved execution may say `yes`; this
 * layer cannot tell either from where the failure surfaced, so it keeps any producer's verdict and
 * otherwise claims nothing.
 */
export async function discloseUnclassifiedInteractionDispatch(
  dispatch: () => Promise<DaemonResponse | null>,
): Promise<DaemonResponse | null> {
  try {
    const response = await dispatch();
    if (!response || response.ok || response.error.details?.dispatched !== undefined) {
      return response;
    }
    return {
      ok: false,
      error: {
        ...response.error,
        details: { ...response.error.details, dispatched: 'unknown' },
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw discloseUnclassifiedDispatch(error, 'unknown');
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
