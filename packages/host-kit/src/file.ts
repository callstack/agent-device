import fs from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { lstatIfPresent } from './internal/verified-file.ts';

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

/** Identifies the current output at a path. Directory identity stays stable as entries change. */
export function outputFileIdentity(stat: Stats): string {
  const inode = `${stat.dev}:${stat.ino}`;
  return stat.isDirectory() ? inode : `${inode}:${stat.size}:${stat.mtimeMs}`;
}

/**
 * Creates missing directory levels privately (`0o700` on POSIX) without modifying any
 * pre-existing directory's permissions. Does not restrict Windows ACLs (POSIX-only privacy
 * model per `docs/agents/security.md`).
 */
export function ensurePrivateDirectorySync(directory: string): void {
  const resolved = path.resolve(directory);
  if (lstatIfPresent(resolved)) return;
  const parent = path.dirname(resolved);
  if (parent !== resolved && !lstatIfPresent(parent)) {
    ensurePrivateDirectorySync(parent);
  }
  let created = false;
  try {
    fs.mkdirSync(resolved, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  // Windows chmod only toggles the read-only attribute; avoid claiming ACL restriction there.
  if (created && process.platform !== 'win32') {
    fs.chmodSync(resolved, 0o700);
  }
}
