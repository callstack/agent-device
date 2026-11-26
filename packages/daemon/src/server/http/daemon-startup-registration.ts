import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { inspectProcessLock } from '@agent-device/host-kit/file';
import {
  DAEMON_STARTUP_EXIT_CODES,
  tryAcquireDaemonRegistration,
  type DaemonRegistrationOwner,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { processLockHoldsDaemonIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonStartupProgress } from '@agent-device/daemon-contracts/daemon-startup-phases';
import type { StartupRollback } from './server-shutdown.ts';
import { finishDaemonRegistration } from './daemon-startup-diagnostics.ts';

const DAEMON_REGISTRATION_REASONS = {
  // Another daemon holds this state directory, or its registration could not be proven free, so
  // this daemon did not start; `details.status` says which.
  refused: { reason: 'daemon_registration_refused' },
} as const satisfies ReasonTable<'daemon lifecycle'>;

export async function acquireDaemonStartupRegistration(options: {
  paths: DaemonPaths;
  rollback: StartupRollback;
  progress?: DaemonStartupProgress;
  requireProcessIdentity: boolean;
}): Promise<DaemonRegistrationOwner> {
  const { paths, rollback, progress, requireProcessIdentity } = options;
  const acquisition = await tryAcquireDaemonRegistration(paths);
  if (acquisition.status !== 'acquired') throw registrationRefused(acquisition.status);
  const registration = acquisition.owner;
  rollback.onRollback(async () => {
    await finishDaemonRegistration({
      registration,
      infoPath: paths.infoPath,
      logPath: paths.logPath,
      close: { retainRegistration: false },
    });
  });
  if (
    requireProcessIdentity &&
    !processLockHoldsDaemonIdentity(inspectProcessLock(paths.lockPath), readCurrentOwnerIdentity())
  )
    throw registrationRefused('unproven');
  progress?.report('lock-acquired');
  return registration;
}

function registrationRefused(status: keyof typeof DAEMON_STARTUP_EXIT_CODES): AppError {
  return new AppError('COMMAND_FAILED', `Daemon registration ${status}.`, {
    reason: DAEMON_REGISTRATION_REASONS.refused.reason,
    status,
    exitCode: DAEMON_STARTUP_EXIT_CODES[status],
  });
}
