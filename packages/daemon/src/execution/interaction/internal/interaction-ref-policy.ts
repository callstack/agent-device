import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import type { RefFrameRejectReason, RefMutationFrame } from '../../../core/ref-frame.ts';
import { interactionErrorResponse } from './interaction-response.ts';

export function refMutationAdmissionResponse(params: {
  ref: string;
  mintedGeneration: number | undefined;
  staleRefsWarning: string | undefined;
  frame: RefMutationFrame;
}): DaemonResponse | null {
  try {
    assertRefMutationAdmitted(params);
    return null;
  } catch (error) {
    if (error instanceof AppError) {
      return interactionErrorResponse(error.code, error.message, error.details);
    }
    throw error;
  }
}

export function assertRefMutationAdmitted(params: {
  ref: string;
  mintedGeneration: number | undefined;
  staleRefsWarning?: string;
  frame: RefMutationFrame;
}): void {
  const refBody = params.ref.startsWith('@') ? params.ref.slice(1) : params.ref;
  const { admission, scope, currentGeneration } = params.frame;
  if (admission.admitted) return;

  const suggestedRef =
    admission.reason === 'plain_ref_requires_complete_frame' &&
    scope !== 'all' &&
    scope.has(refBody) &&
    currentGeneration !== undefined
      ? `@${refBody}~s${currentGeneration}`
      : undefined;
  const replacement = settledDiffReplacement(params.frame, suggestedRef);
  throw new AppError(
    'COMMAND_FAILED',
    rejectionMessage(admission.reason, params.ref, replacement),
    {
      reason: admission.reason,
      ref: params.ref,
      currentGeneration,
      scope: scope === 'all' ? 'all' : Array.from(scope),
      ...(params.mintedGeneration !== undefined
        ? { mintedGeneration: params.mintedGeneration }
        : {}),
      ...(suggestedRef ? { suggestedRef } : {}),
      ...(replacement ? { replacedBy: 'settle-diff' } : {}),
      ...(replacement?.replacementRefs ? { replacementRefs: replacement.replacementRefs } : {}),
      hint: suggestedRef
        ? `Retry with the exact emitted ref ${suggestedRef}.`
        : (replacement?.hint ?? params.staleRefsWarning ?? REJECTION_HINT),
    },
  );
}

const REJECTION_HINT =
  'Capture a fresh interactive snapshot (snapshot -i) or use a stable selector, then retry.';

/**
 * The settled-diff replacement of a plain-ref refusal (#4571): the refusal names the diff
 * that replaced the frame and hands back the refs that diff issued, each pinned to the
 * epoch the caller faces (#4853 paste-ready standard). The frame already authorized
 * exactly these bodies at this epoch, so printing them issues nothing new — a pasted ref
 * is admitted without another capture. Undefined for every other refusal shape.
 */
type SettledDiffReplacement = {
  /** `details.replacementRefs`; absent when the diff issued none or the exact-emitted suggestion won. */
  replacementRefs: string[] | undefined;
  /** The replacement hint; absent when the refusal keeps the recapture guidance. */
  hint: string | undefined;
};

function settledDiffReplacement(
  frame: RefMutationFrame,
  suggestedRef: string | undefined,
): SettledDiffReplacement | undefined {
  if (
    frame.admission.admitted ||
    frame.admission.reason !== 'plain_ref_requires_complete_frame' ||
    frame.origin !== 'settle-diff'
  ) {
    return undefined;
  }
  const replacementRefs =
    suggestedRef === undefined &&
    frame.scope !== 'all' &&
    frame.scope.size > 0 &&
    frame.currentGeneration !== undefined
      ? Array.from(frame.scope, (body) => `@${body}~s${frame.currentGeneration}`)
      : undefined;
  return {
    replacementRefs,
    hint: replacementRefs ? settleReplacementHint(replacementRefs) : undefined,
  };
}

/** The replacement route for a settled-diff frame: the diff's issued refs, ready to paste. */
function settleReplacementHint(replacementRefs: string[]): string {
  const list = replacementRefs.join(', ');
  return replacementRefs.length === 1
    ? `Retry with the ref the settled diff issued: ${list} — or capture a fresh interactive snapshot (snapshot -i).`
    : `Retry with one of the refs the settled diff issued: ${list} — or capture a fresh interactive snapshot (snapshot -i).`;
}

function rejectionMessage(
  reason: RefFrameRejectReason,
  ref: string,
  replacement: SettledDiffReplacement | undefined,
): string {
  switch (reason) {
    case 'ref_frame_expired':
      return `Ref ${ref} belongs to an expired ref frame — a device action since the snapshot invalidated it`;
    case 'ref_generation_mismatch':
      return `Ref ${ref} was minted from a superseded snapshot generation`;
    case 'plain_ref_requires_complete_frame':
      if (!replacement) {
        return `Ref ${ref} needs a complete snapshot — the current frame only authorizes its emitted refs`;
      }
      return replacement.replacementRefs
        ? `Ref ${ref} needs a complete snapshot — a settled diff replaced the ref frame and only authorizes its issued refs`
        : `Ref ${ref} needs a complete snapshot — a settled diff replaced the ref frame and issued no refs`;
    case 'ref_not_issued':
      return `Ref ${ref} was not issued by the current ref frame`;
  }
}
