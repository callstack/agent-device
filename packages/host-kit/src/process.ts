export {
  expandProcessTree,
  hostCurrentWorkingDirectory,
  hostEnvironment,
  hostNodeExecutablePath,
  hostNodeVersion,
  hostPlatform,
  hostProcessId,
  type HostProcessIdentityObservation,
  type HostProcessInfo,
  isProcessAlive,
  isProcessGroupAlive,
  isProcessZombie,
  listHostProcesses,
  readHostProcessIdentityObservations,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  signalProcessGroupBestEffort,
  stopPidsWithEscalation,
  uniquePositivePids,
  waitForProcessExit,
} from './internal/host-process.ts';
export { reapOwnedProcessRecordsAtStartup } from './internal/owned-process-reaper.ts';
export {
  createOwnedProcessRecordStore,
  type OwnedProcessRecordStore,
  readOwnedProcessRecordFile,
} from './internal/owned-process-record.ts';
export {
  classifyOwnerLiveness,
  classifyOwnerLivenessFromObservation,
  type OwnerIdentity,
  ownerIdentityDiffers,
  ownerIdentityMatches,
  type OwnerLiveness,
  readCurrentOwnerIdentity,
} from './internal/owner-identity.ts';
