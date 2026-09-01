export {
  isAtomicPublishTemporaryPath,
  publishFileSync,
  withAtomicPublishTempPathSync,
} from './internal/atomic-file.ts';
export {
  lstatIfPresent,
  NOT_REGULAR_FILE_HINT,
  openVerifiedFileForAppend,
  openVerifiedFileForRead,
  openVerifiedFileForTruncate,
} from './internal/verified-file.ts';
export { expandUserHomePath, resolveUserPath } from './internal/path-resolution.ts';
export { acquireProcessLock, type ProcessLockOwner } from './internal/process-lock.ts';
