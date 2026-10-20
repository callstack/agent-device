import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import {
  stopDaemon,
  mergeDaemonShutdownReport,
  type DaemonStopResult,
} from '@agent-device/daemon-contracts/daemon-stop';
import { AppError } from '@agent-device/kernel/errors';
import {
  daemonNotRetirableError,
  daemonRecordOwnerUnrecognizedError,
} from './daemon-lifecycle-errors.ts';
import type { DaemonLifecycleTarget } from './daemon-client-lifecycle-request.ts';

export async function stopRecordedDaemon(
  record: DaemonStopIdentity,
  target: DaemonLifecycleTarget,
): Promise<DaemonStopResult> {
  if (record.ownership === 'unreadable') throw daemonRecordUnreadableError(target.paths);
  if (record.ownership === 'embedded' || record.ownership === 'unknown') {
    const info = record.identity
      ? { pid: record.identity.pid, processStartTime: record.identity.startTime ?? undefined }
      : null;
    const params = { info, stateDir: target.paths.baseDir };
    throw record.ownership === 'embedded'
      ? daemonNotRetirableError(params)
      : daemonRecordOwnerUnrecognizedError(params);
  }
  const observed = record.identity ? { ...record.identity, ownership: 'detached' as const } : null;
  const stopped = await stopDaemon({ paths: target.paths, observed });
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
