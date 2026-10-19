import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import {
  observedDaemonIdentityOfRegistration,
  type DaemonStopIdentity,
} from '@agent-device/daemon-contracts/daemon-registration';
import {
  stopDaemon,
  mergeDaemonShutdownReport,
  type DaemonStopResult,
} from '@agent-device/daemon-contracts/daemon-stop';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError } from '@agent-device/kernel/errors';

/**
 * Stops the daemon one registration read names. Ownership travels with the lifetime it read, and the
 * central retirement judges it: an embedded runtime or an unrecognized owner comes back as the refusal
 * that names its owner, with nothing signaled.
 */
export async function stopRecordedDaemon(
  record: DaemonStopIdentity,
  paths: DaemonPaths,
): Promise<DaemonStopResult> {
  if (record.ownership === 'unreadable') {
    throw new AppError(
      'COMMAND_FAILED',
      `The daemon record on ${paths.baseDir} cannot be read, so this stop cannot tell whether a daemon runs.`,
      {
        reason: 'daemon-record-unreadable',
        stateDir: paths.baseDir,
        hint: 'Nothing was signaled. Inspect or remove that record, then retry.',
      },
    );
  }
  // The retirement judges the owner this one read stated; nothing here decides it.
  const stopped = await stopDaemon({
    paths,
    observed: observedDaemonIdentityOfRegistration(record),
  });
  return mergeDaemonShutdownReport(
    stopped,
    stopped.mode === 'graceful' ? readDaemonShutdownReport(paths.baseDir) : null,
  );
}
