import { isInfrastructureBootFailureReason } from '../../platforms/boot-diagnostics.ts';
import type { DaemonResponse } from '../types.ts';
import type { ReplaySuiteTestResult } from '../../contracts/replay.ts';

const REPLAY_INFRASTRUCTURE_FAILURE_MESSAGE_PATTERNS = [
  'failed to start daemon',
  'runner did not accept connection',
  'xcodebuild exited early',
  'device is offline',
  'device offline',
  'device unauthorized',
] as const;

type ReplayFailureError = Extract<DaemonResponse, { ok: false }>['error'];

export function isReplayInfrastructureFailure(
  result: DaemonResponse | ReplaySuiteTestResult,
): boolean {
  const error = readReplayFailureError(result);
  if (!error) return false;
  return (
    hasInfrastructureFailureReason(error.details) ||
    hasInfrastructureFailureMessage(error.code, error.message)
  );
}

function readReplayFailureError(
  result: DaemonResponse | ReplaySuiteTestResult,
): ReplayFailureError | null {
  if ('ok' in result) return result.ok ? null : result.error;
  return result.status === 'failed' ? result.error : null;
}

function hasInfrastructureFailureReason(details: Record<string, unknown> | undefined): boolean {
  const reason = typeof details?.reason === 'string' ? details.reason : '';
  if (reason === 'timeout_cleanup_pending') return true;
  return reason ? isInfrastructureBootFailureReason(reason) : false;
}

function hasInfrastructureFailureMessage(code: string, message: string): boolean {
  const text = `${code}\n${message}`.toLowerCase();
  return REPLAY_INFRASTRUCTURE_FAILURE_MESSAGE_PATTERNS.some((pattern) => text.includes(pattern));
}
