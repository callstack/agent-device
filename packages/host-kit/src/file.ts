export {
  isAtomicPublishTemporaryPath,
  publishDurableFileSync,
  publishFileSync,
  type DurableFilePublishMode,
} from './internal/atomic-publish.ts';
export {
  admitPrivateRoot,
  type PrivateRootAdmission,
  prepareScriptDestination,
  publishScriptFileSync,
  type ScriptDestinationOptions,
} from './internal/script-destination.ts';
export { scriptAncestryReason } from './internal/script-destination-refusal.ts';
export { resolveScriptDestination } from './internal/entry-name.ts';
export {
  assertScriptTargetVacant,
  lstatIfPresent,
  NOT_REGULAR_FILE_HINT,
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
} from './internal/verified-file.ts';
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
  PROCESS_LOCK_REASONS,
} from './internal/process-lock.ts';
