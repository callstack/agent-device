import {
  admitRefMutation,
  refFrameEpoch,
  refFrameScope,
  type RefFrameRejectReason,
} from '../ref-frame.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';

/**
 * ADR 0014 mutation-admission enforcement. A ref-targeting mutation is admitted
 * only against an active frame whose epoch and issuance scope authorize the ref
 * (`admitRefMutation`). This runs BEFORE resolution and dispatch, on EVERY
 * supported platform — a device side effect from an earlier command expires the
 * frame at its seam, so the next ref mutation is rejected before it can act on a
 * possibly-navigated screen.
 *
 * Returns `null` when the mutation is admitted, or a typed failure whose
 * `details.reason` distinguishes "capture a complete snapshot" from "use the
 * emitted pinned ref". The message names the actual lifetime failure rather than
 * claiming the ref was missing or lacked bounds.
 */
export function refMutationAdmissionResponse(params: {
  session: SessionState;
  ref: string;
  mintedGeneration: number | undefined;
  /**
   * The precise staleness diagnostic the caller already resolved
   * (`resolveRefStalenessWarning`). Used as the failure hint when present — for
   * a pinned generation mismatch it names the exact minted-vs-current
   * generations — otherwise a generic actionable hint is attached.
   */
  staleRefsWarning: string | undefined;
}): DaemonResponse | null {
  const refBody = params.ref.startsWith('@') ? params.ref.slice(1) : params.ref;
  const admission = admitRefMutation({
    session: params.session,
    refBody,
    mintedGeneration: params.mintedGeneration,
  });
  if (admission.admitted) return null;

  const scope = refFrameScope(params.session);
  return errorResponse('COMMAND_FAILED', rejectionMessage(admission.reason, params.ref), {
    reason: admission.reason,
    ref: params.ref,
    currentGeneration: refFrameEpoch(params.session),
    scope: scope === 'all' ? 'all' : Array.from(scope),
    ...(params.mintedGeneration !== undefined ? { mintedGeneration: params.mintedGeneration } : {}),
    hint: params.staleRefsWarning ?? REJECTION_HINT,
  });
}

const REJECTION_HINT =
  'Capture a fresh interactive snapshot (snapshot -i) or use a stable selector, then retry.';

function rejectionMessage(reason: RefFrameRejectReason, ref: string): string {
  switch (reason) {
    case 'ref_frame_expired':
      return `Ref ${ref} belongs to an expired ref frame — a device action since the snapshot invalidated it`;
    case 'ref_generation_mismatch':
      return `Ref ${ref} was minted from a superseded snapshot generation`;
    case 'plain_ref_requires_complete_frame':
      return `Ref ${ref} needs a complete snapshot — the current frame only authorizes its emitted refs`;
    case 'ref_not_issued':
      return `Ref ${ref} was not issued by the current ref frame`;
  }
}
