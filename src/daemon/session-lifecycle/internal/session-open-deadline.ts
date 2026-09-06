import { markRequestCanceled } from '@agent-device/host-kit/request';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { errorResponse } from '../../response.ts';

/** Cancels startup inside the daemon, leaving the client envelope for owned cleanup. */
export async function withOpenStartupDeadline(
  req: DaemonRequest,
  open: (req: DaemonRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  const timeoutMs = req.flags?.timeoutMs;
  if (timeoutMs === undefined) return await open(req);
  const timedRequest = {
    ...req,
    internal: { ...req.internal, startupDeadlineAtMs: Date.now() + timeoutMs },
  };
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    markRequestCanceled(req.meta?.requestId);
  }, timeoutMs);
  try {
    const response = await open(timedRequest);
    return expired && !response.ok ? startupTimeoutResponse(timeoutMs) : response;
  } catch (error) {
    if (!expired) throw error;
    if (error instanceof AppError && error.details?.reason === 'ios_boot_cleanup_failed')
      throw error;
    return startupTimeoutResponse(timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

function startupTimeoutResponse(timeoutMs: number): DaemonResponse {
  return errorResponse('COMMAND_FAILED', 'Application startup deadline exceeded', {
    reason: 'startup_timeout',
    timeoutMs,
  });
}
