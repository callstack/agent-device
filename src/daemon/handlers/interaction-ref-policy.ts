import { publicPlatformString } from '../../kernel/device.ts';
import { admitRefMutation } from '../ref-frame.ts';
import { STALE_SNAPSHOT_REFS_WARNING } from '../session-snapshot.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';

/**
 * Mutating through a ref from an older client-visible tree is never safe on iOS
 * (#1239). The decision now flows through the ADR 0014 ref-frame admission
 * matrix (`admitRefMutation`): a pinned ref whose generation no longer matches
 * the frame epoch, an expired frame, or a ref outside a partial issuance scope
 * is refused.
 *
 * Transitional: until frame expiration at the device side-effect seam replaces
 * the coarse `snapshotRefsStale` marker (ADR 0014 step 3), a plain ref whose
 * operational observation was reindexed by an internal capture is also refused
 * on iOS. The external error contract (code, message, hint) is unchanged.
 */
export function staleIosRefGuardResponse(params: {
  session: SessionState;
  ref: string;
  mintedGeneration: number | undefined;
  staleRefsWarning: string | undefined;
}): DaemonResponse | null {
  if (publicPlatformString(params.session.device) !== 'ios') return null;

  const refBody = params.ref.startsWith('@') ? params.ref.slice(1) : params.ref;
  const admission = admitRefMutation({
    session: params.session,
    refBody,
    mintedGeneration: params.mintedGeneration,
  });
  const coarsePlainStale =
    params.mintedGeneration === undefined && params.session.snapshotRefsStale === true;
  if (admission.admitted && !coarsePlainStale) return null;

  return errorResponse('COMMAND_FAILED', `Ref ${params.ref} not found or has no bounds`, {
    hint: params.staleRefsWarning ?? STALE_SNAPSHOT_REFS_WARNING,
  });
}
