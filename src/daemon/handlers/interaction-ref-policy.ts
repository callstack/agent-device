import { publicPlatformString } from '../../kernel/device.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { errorResponse } from './response.ts';

/** Mutating through a ref from an older client-visible tree is never safe on iOS. */
export function staleIosRefGuardResponse(params: {
  session: SessionState;
  ref: string;
  staleRefsWarning: string | undefined;
}): DaemonResponse | null {
  if (
    params.staleRefsWarning === undefined ||
    publicPlatformString(params.session.device) !== 'ios'
  ) {
    return null;
  }
  return errorResponse('COMMAND_FAILED', `Ref ${params.ref} not found or has no bounds`, {
    hint: params.staleRefsWarning,
  });
}
