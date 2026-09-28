import {
  AppError,
  type DispatchDisclosure,
  discloseUnclassifiedDispatch,
} from '@agent-device/kernel/errors';
import type { DaemonResponse } from '../../daemon-request.ts';
import { readSessionRuntimeRevision } from '../../ref-frame.ts';
import type { SessionState } from '../../session-state.ts';

/**
 * The ADR 0014 side-effect seam as the dispatch verdict for an interaction failure no producer
 * classified: a failure before this request crossed the seam never reached the device (`no`); one
 * after it may have (`unknown`). A producer's own verdict is kept.
 */
export async function discloseDispatchAtSideEffectSeam(
  session: SessionState | undefined,
  dispatch: () => Promise<DaemonResponse | null>,
): Promise<DaemonResponse | null> {
  const revisionBeforeDispatch = session ? readSessionRuntimeRevision(session) : undefined;
  const seamVerdict = (): DispatchDisclosure =>
    session && readSessionRuntimeRevision(session) !== revisionBeforeDispatch ? 'unknown' : 'no';
  try {
    const response = await dispatch();
    if (!response || response.ok || response.error.details?.dispatched !== undefined) {
      return response;
    }
    return {
      ok: false,
      error: {
        ...response.error,
        details: { ...response.error.details, dispatched: seamVerdict() },
      },
    };
  } catch (error) {
    if (error instanceof AppError) throw discloseUnclassifiedDispatch(error, seamVerdict());
    throw error;
  }
}
