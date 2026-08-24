import type { DaemonResponse } from '../types.ts';

export type DaemonFailureResponse = Extract<DaemonResponse, { ok: false }>;

export const NO_ACTIVE_SESSION_MESSAGE = 'No active session. Run open first.';

export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  options?: { hint?: string; retriable?: boolean },
): DaemonFailureResponse {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(options?.hint ? { hint: options.hint } : {}),
      ...(options?.retriable === undefined ? {} : { retriable: options.retriable }),
      ...(details ? { details } : {}),
    },
  };
}

/**
 * Shared "No active session. Run open first." failure used by handlers that require
 * an open session before dispatching.
 */
export function noActiveSessionError(): DaemonFailureResponse {
  return errorResponse('SESSION_NOT_FOUND', NO_ACTIVE_SESSION_MESSAGE);
}
