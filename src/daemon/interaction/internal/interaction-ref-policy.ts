import { AppError } from '@agent-device/kernel/errors';
import type { DaemonResponse } from '../../types.ts';
import type { RefFrameRejectReason, RefMutationFrame } from '../../ref-frame.ts';
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
  throw new AppError('COMMAND_FAILED', rejectionMessage(admission.reason, params.ref), {
    reason: admission.reason,
    ref: params.ref,
    currentGeneration,
    scope: scope === 'all' ? 'all' : Array.from(scope),
    ...(params.mintedGeneration !== undefined ? { mintedGeneration: params.mintedGeneration } : {}),
    ...(suggestedRef ? { suggestedRef } : {}),
    hint: suggestedRef
      ? `Retry with the exact emitted ref ${suggestedRef}.`
      : (params.staleRefsWarning ?? REJECTION_HINT),
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
