import type { HostEnvironment } from '@agent-device/kernel/source-value';

export {
  captureHostEnvironment,
  type HostEnvironmentSource,
  type ConfirmedProcessStop,
  confirmedProcessStopDetails,
  type ConfirmedProcessStopDetails,
  describeUnconfirmedProcessStop,
  expandProcessTree,
  type GracefulStopSignal,
  hostNodeExecutablePath,
  hostNodeVersion,
  hostPlatform,
  hostProcessId,
  type HostProcessIdentityFacts,
  type HostProcessIdentityObservation,
  type HostProcessInfo,
  isProcessAlive,
  isProcessGroupAlive,
  isProcessZombie,
  judgeProcessIdentity,
  listHostProcesses,
  type ProcessIdentityVerdict,
  type ProcessStopBudget,
  type ProcessStopIdentity,
  type ProcessStopTarget,
  readConfirmedProcessStopDetails,
  readHostCpuArch,
  readHostCpuArchSync,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
  readProcessCommand,
  readProcessIdentities,
  readProcessIdentityFacts,
  readProcessStartTime,
  processStartTimesDiffer,
  signalPidsBestEffort,
  stopProcessAndConfirmExit,
  uniquePositivePids,
  waitForProcessExit,
  writeHostStderr,
} from './internal/host-process.ts';
export { signalProcessGroupBestEffort } from './internal/exec.ts';
export { reapOwnedProcessRecordsAtStartup } from './internal/owned-process-reaper.ts';
export {
  createOwnedProcessRecordStore,
  type OwnedProcessRecordStore,
  readOwnedProcessRecordFile,
} from './internal/owned-process-record.ts';
export {
  classifyOwnerLiveness,
  classifyOwnerLivenessAsync,
  classifyOwnerLivenessFromObservation,
  isProcessPid,
  type OwnerIdentity,
  ownerIdentityDiffers,
  ownerIdentityMatches,
  type OwnerLiveness,
  readCurrentOwnerIdentity,
} from './internal/owner-identity.ts';

/** Observes actual executable paths. Missing entries are unknown, not proof of exit. */
export async function readProcessExecutablePaths(
  pids: Iterable<number>,
  host: HostEnvironment,
  timeoutMs?: number,
): Promise<ReadonlyMap<number, string>> {
  const observer = await import('./internal/process-executable-path.ts');
  return await observer.readProcessExecutablePaths(pids, host, timeoutMs);
}
