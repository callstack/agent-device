import { Deadline } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { resolveCommandTimeoutPolicy } from '@agent-device/command-registry/registry';
import { resolveCommandRequestTimeoutMs } from '@agent-device/command-registry/timeout-policy';
import {
  DAEMON_SESSION_TEARDOWN_TIMEOUT_MS,
  SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS,
} from '../session-teardown-budget.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import type { ManagedCommandHorizon } from './lease-admission.ts';

const MANAGED_COMMAND_TEARDOWN_TIMEOUT_MS =
  DAEMON_SESSION_TEARDOWN_TIMEOUT_MS + SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS;

/** Reserve recording cleanup even when this command is the one that starts the capture. */
export function managedCommandHorizon(
  req: Omit<DaemonRequest, 'token'>,
  startedAtMs: number,
): ManagedCommandHorizon {
  const timeoutMs = resolveCommandRequestTimeoutMs(resolveCommandTimeoutPolicy(req.command), req);
  if (
    timeoutMs === undefined ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(startedAtMs)
  ) {
    throw new AppError(
      'UNSUPPORTED_OPERATION',
      'Managed commands require a finite request deadline.',
      {
        reason: 'managed-command-deadline-unbounded',
      },
    );
  }
  return Object.freeze({
    deadline: Deadline.fromTimeoutMs(timeoutMs, startedAtMs),
    teardownTimeoutMs: MANAGED_COMMAND_TEARDOWN_TIMEOUT_MS,
  });
}
