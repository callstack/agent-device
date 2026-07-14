import { publicPlatformString } from '../../kernel/device.ts';
import { admitRefMutation, refFrameEpoch } from '../ref-frame.ts';
import { STALE_SNAPSHOT_REFS_WARNING } from '../session-snapshot.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';

/**
 * Mutating through a ref from an older client-visible tree is never safe on iOS
 * (#1239). The decision consults the ADR 0014 ref-frame admission matrix
 * (`admitRefMutation`).
 *
 * Migration status: ADR 0014 step 3 wires frame expiration at the device
 * side-effect seam, but ENFORCING the new expired-frame rejection is deferred to
 * step 7, which the ADR gates on fresh live device evidence per platform. Until
 * then this guard enforces exactly the pre-existing conditions — a pinned
 * generation mismatch and the coarse plain-ref stale marker — so a pinned
 * mismatch currently masked by an (unenforced) expiry is still rejected. The
 * external error contract (code, message, hint) is unchanged.
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

  const pinnedMismatch =
    params.mintedGeneration !== undefined &&
    params.mintedGeneration !== refFrameEpoch(params.session);
  // Issuance-scope rejections (partial frames) are enforced now; they are inert
  // until a later step publishes non-`all` scopes.
  const scopeRejected =
    !admission.admitted &&
    (admission.reason === 'plain_ref_requires_complete_frame' ||
      admission.reason === 'ref_not_issued');
  const coarsePlainStale =
    params.mintedGeneration === undefined && params.session.snapshotRefsStale === true;

  if (!pinnedMismatch && !scopeRejected && !coarsePlainStale) return null;

  return errorResponse('COMMAND_FAILED', `Ref ${params.ref} not found or has no bounds`, {
    hint: params.staleRefsWarning ?? STALE_SNAPSHOT_REFS_WARNING,
  });
}
