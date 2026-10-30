import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  observedDaemonIdentityOfRegistration,
  type DaemonStopIdentity,
} from '@agent-device/daemon-contracts/daemon-registration';
import {
  stopDaemon,
  mergeDaemonShutdownReport,
  type DaemonStopResult,
} from '@agent-device/daemon-contracts/daemon-stop';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonLifecycleTarget } from './daemon-client-lifecycle-request.ts';

export async function stopRecordedDaemon(
  record: DaemonStopIdentity,
  target: DaemonLifecycleTarget,
): Promise<DaemonStopResult> {
  if (record.ownership === 'unreadable') throw daemonRecordUnreadableError(target.paths);
  const stopped = await stopDaemon({
    paths: target.paths,
    observed: observedDaemonIdentityOfRegistration(record),
  });
  return mergeDaemonShutdownReport(
    stopped,
    stopped.mode === 'graceful' ? readDaemonShutdownReport(target.paths.baseDir) : null,
  );
}

function daemonRecordUnreadableError(paths: DaemonPaths): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `The daemon record on ${paths.baseDir} cannot be read, so this stop cannot tell whether a daemon runs.`,
    {
      reason: 'daemon-record-unreadable',
      stateDir: paths.baseDir,
      hint: 'Nothing was signaled. Inspect or remove that record, then retry.',
    },
  );
}
