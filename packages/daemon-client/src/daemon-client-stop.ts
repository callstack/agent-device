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
import { daemonRecordUnreadableError } from './daemon-lifecycle-errors.ts';
import type { DaemonLifecycleTarget } from './daemon-client-lifecycle-request.ts';

export async function stopRecordedDaemon(
  record: DaemonStopIdentity,
  target: DaemonLifecycleTarget,
): Promise<DaemonStopResult> {
  if (record.ownership === 'unreadable') throw daemonRecordUnreadableError(target.paths);
  const observed = observedDaemonIdentityOfRegistration(record);
  const stopped = await stopDaemon({
    paths: target.paths,
    observed,
  });
  return mergeDaemonShutdownReport(
    stopped,
    stopped.mode === 'graceful' && observed
      ? // The report is asked for THIS lifetime only: the state directory keeps the reports of earlier
        // runs, and one of those would otherwise be told to the caller as what the daemon that just
        // exited released.
        await readDaemonShutdownReport(target.paths.baseDir, observed)
      : null,
  );
}
