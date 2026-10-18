import { readDaemonShutdownReport } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import type { DaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import {
  stopDaemon,
  mergeDaemonShutdownReport,
  type DaemonStopResult,
} from '@agent-device/daemon-contracts/daemon-stop';
import type { DaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';

export async function stopRecordedDaemon(
  record: DaemonStopIdentity,
  target: { paths: DaemonPaths; host: HostEnvironment },
): Promise<DaemonStopResult> {
  if (record.ownership === 'unreadable') {
    throw new AppError(
      'COMMAND_FAILED',
      `The daemon record on ${target.paths.baseDir} cannot be read, so this stop cannot tell whether a daemon runs.`,
      {
        reason: 'daemon-record-unreadable',
        stateDir: target.paths.baseDir,
        hint: 'Nothing was signaled. Inspect or remove that record, then retry.',
      },
    );
  }
  const observed =
    record.identity &&
    (record.ownership === 'embedded' ||
      record.ownership === 'unknown' ||
      record.ownership === 'detached')
      ? { ...record.identity, ownership: record.ownership }
      : null;
  let stopped: DaemonStopResult;
  try {
    stopped = await stopDaemon({ paths: target.paths, observed });
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.details?.terminationReason === 'embedded-owner' ||
        error.details?.terminationReason === 'owner-unproven')
    ) {
      throw new AppError(error.code, error.message, {
        ...error.details,
        reason:
          error.details.terminationReason === 'embedded-owner'
            ? 'daemon-owner-embedded'
            : 'daemon-owner-unrecognized',
        hint: 'Nothing was signaled. Close the host that started this runtime, or repair its record after the process has exited.',
      });
    }
    throw error;
  }
  return mergeDaemonShutdownReport(
    stopped,
    stopped.mode === 'graceful' ? readDaemonShutdownReport(target.paths.baseDir) : null,
  );
}
