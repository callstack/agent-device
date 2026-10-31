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
  const stopped = await stopDaemon({
    paths: target.paths,
    observed: observedDaemonIdentityOfRegistration(record),
  });
  return mergeDaemonShutdownReport(
    stopped,
    stopped.mode === 'graceful' ? readDaemonShutdownReport(target.paths.baseDir) : null,
  );
}
