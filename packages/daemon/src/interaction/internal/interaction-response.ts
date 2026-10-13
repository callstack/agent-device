import type { DaemonResponse } from '../../daemon-request.ts';

export function interactionErrorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): DaemonResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
    },
  };
}
