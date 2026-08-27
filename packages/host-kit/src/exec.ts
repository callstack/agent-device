export {
  coerceExecResult,
  execFailureDetails,
  isExecutablePath,
  requireExecSuccess,
  resolveExecutableOverridePath,
  resolveFileOverridePath,
  runCmd,
  runCmdBackground,
  runCmdDetached,
  runCmdDetachedMonitored,
  runCmdStreaming,
  runCmdSync,
  whichCmd,
  withCommandExecutorOverride,
  withoutCommandExecutorOverride,
  type CommandExecutorOverride,
  type ExecBackgroundOptions,
  type ExecBackgroundResult,
  type ExecDetachedExit,
  type ExecDetachedProcess,
  type ExecOptions,
  type ExecResult,
} from './internal/exec.ts';
export {
  countDiagnosticEventsByPhase,
  createRequestId,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  updateDiagnosticsScope,
  withDiagnosticTimer,
  withDiagnosticsScope,
  type FlushedDiagnosticsRecord,
} from './internal/diagnostics.ts';
export {
  expandProcessTree,
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
  type HostProcessIdentityObservation,
  type HostProcessInfo,
  type ListHostProcessesOptions,
  type StopPidsWithEscalationOptions,
} from './internal/host-process.ts';
export {
  reapOwnedProcessRecordsAtStartup,
  type OwnedProcessReapSummary,
} from './internal/owned-process-reaper.ts';
export {
  createOwnedProcessRecordStore,
  readOwnedProcessRecordFile,
  type OwnedProcessRecordRead,
  type OwnedProcessRecordStore,
} from './internal/owned-process-record.ts';
export {
  classifyOwnerLiveness,
  classifyOwnerLivenessFromObservation,
  ownerIdentityDiffers,
  ownerIdentityMatches,
  readCurrentOwnerIdentity,
  type OwnerIdentity,
  type OwnerLiveness,
} from './internal/owner-identity.ts';
export { shellQuote, shellQuoteIfNeeded } from './internal/shell-quote.ts';
export { sleep } from './internal/timeouts.ts';
export { Deadline, isEnvTruthy, retryWithPolicy } from './internal/retry.ts';
