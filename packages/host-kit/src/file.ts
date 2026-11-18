export {
  isAtomicPublishTemporaryPath,
  publishDurableFileSync,
  publishFileSync,
  type DurableFilePublishMode,
} from './internal/atomic-publish.ts';
export {
  confirmScriptDestination,
  isWindowsShareUnavailable,
  judgeScriptDestination,
  prepareScriptDestination,
  publishScriptFileSync,
  type ScriptDestination,
  type ScriptDestinationOptions,
} from './internal/script-destination.ts';
export { scriptAncestryReason } from './internal/script-destination-refusal.ts';
export { resolveScriptDestination } from './internal/entry-name.ts';
export {
  appendPrivateStateFileSync,
  assertScriptTargetVacant,
  ensurePrivateDirectoryChain,
  judgePrivateDirectoryChain,
  privateDirectoryWordingOf,
  PRIVATE_STATE_DIR_REASON,
  type PrivateDirectoryChain,
  type PrivateDirectoryExposure,
  NOT_REGULAR_FILE_HINT,
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
  publishPrivateStateFileSync,
  readPrivateStateFileTailSync,
  readPrivateStateWholeFileSync,
  type PrivateStateRead,
  type PrivateStateOpenPurpose,
  tryOpenPrivateStateFileSync,
  writePrivateStateLineSync,
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
