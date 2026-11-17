export {
  confirmScriptDestination,
  scriptAncestryReason,
  isAtomicPublishTemporaryPath,
  lstatIfPresent,
  prepareScriptDestination,
  publishDurableFileSync,
  publishFileSync,
  publishScriptFileSync,
  verifiedDirectoryPath,
  childPath,
  withoutTrailingSeparators,
  type DurableFilePublishMode,
  type ScriptDestination,
} from './internal/atomic-file.ts';
export {
  NOT_REGULAR_FILE_HINT,
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
} from './internal/verified-file.ts';
export {
  expandUserHomePath,
  resolveUserConfigPath,
  resolveDeviceClaimRoot,
  resolveUserPath,
} from './internal/path-resolution.ts';
export {
  acquireProcessLock,
  acquireProcessLockAcquisition,
  tryAcquireProcessLock,
  inspectProcessLock,
  withProcessLock,
  type ProcessLockAcquisition,
  type ProcessLockAttempt,
  type ProcessLockInspection,
  type ProcessLockOwner,
  type ProcessLockRelease,
} from './internal/process-lock.ts';
