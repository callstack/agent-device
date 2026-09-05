import { Deadline } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { resolveDaemonRequestTimeoutMs } from '../request-timeout.ts';
import { resolveDaemonSessionTeardownTimeoutMs } from '../session-teardown-budget.ts';
import type { DaemonRequest } from '../types.ts';
import type { ManagedCommandHorizon } from './lease-admission.ts';

/** Reserve recording cleanup even when this command is the one that starts the capture. */
export function managedCommandHorizon(
  req: Omit<DaemonRequest, 'token'>,
  startedAtMs: number,
): ManagedCommandHorizon {
  const timeoutMs = resolveDaemonRequestTimeoutMs(req);
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
    teardownTimeoutMs: resolveDaemonSessionTeardownTimeoutMs(undefined, true),
  });
}
