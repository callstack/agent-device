import {
  isInfrastructureAdbFailure,
  isInfrastructureBootFailureReason,
} from '@agent-device/contracts/boot-failure';
import type { ReplaySuiteTestResult } from '@agent-device/contracts/replay';
import { isDeviceClaimConflictReason } from '@agent-device/contracts/device';
import { type DaemonResponse } from '@agent-device/kernel/contracts';

type ReplayFailureError = Extract<DaemonResponse, { ok: false }>['error'];

export function isReplayInfrastructureFailure(
  result: DaemonResponse | ReplaySuiteTestResult,
): boolean {
  if (!('ok' in result) && result.status === 'failed' && result.infrastructure === true)
    return true;
  const error = readReplayFailureError(result);
  if (!error) return false;
  return hasInfrastructureFailureDetails(error.details);
}

function readReplayFailureError(
  result: DaemonResponse | ReplaySuiteTestResult,
): ReplayFailureError | null {
  if ('ok' in result) return result.ok ? null : result.error;
  return result.status === 'failed' ? result.error : null;
}

function hasInfrastructureFailureDetails(details: Record<string, unknown> | undefined): boolean {
  if (details?.recovery === 'runner_recycle_budget_exhausted') return true;
  if (isInfrastructureAdbFailure(details?.adbFailure)) return true;
  const reason = typeof details?.reason === 'string' ? details.reason : '';
  if (reason === 'timeout_cleanup_pending') return true;
  if (isDeviceClaimConflictReason(reason)) return true;
  return reason ? isInfrastructureBootFailureReason(reason) : false;
}
