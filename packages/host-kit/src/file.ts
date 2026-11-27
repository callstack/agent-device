import fs from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { lstatIfPresent } from './internal/verified-file.ts';

export {
  isAtomicPublishTemporaryPath,
  publishDurableFileSync,
  publishFileSync,
  type DurableFilePublishMode,
} from './internal/atomic-publish.ts';
import {
  admitPrivateRoot,
  ensurePrivateChildWithAncestrySync,
  ensurePrivateDirectoryWithAncestrySync,
  type PrivateRootAdmission,
  prepareScriptDestination,
  publishScriptFileSync,
  type ScriptDestinationOptions,
} from './internal/script-destination.ts';
import {
  PrivateDirectoryInitializingError,
  PrivateDirectoryUnsafeError,
  scriptAncestryReason,
} from './internal/script-destination-refusal.ts';
export {
  admitPrivateRoot,
  type PrivateRootAdmission,
  prepareScriptDestination,
  publishScriptFileSync,
  type ScriptDestinationOptions,
};
export { PrivateDirectoryInitializingError, PrivateDirectoryUnsafeError, scriptAncestryReason };
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

const PRIVATE_DIR_MODE = 0o700;

/** Identifies the current output at a path. Directory identity stays stable as entries change. */
export function outputFileIdentity(stat: Stats): string {
  const inode = `${stat.dev}:${stat.ino}`;
  return stat.isDirectory() ? inode : `${inode}:${stat.size}:${stat.mtimeMs}`;
}

/**
 * Verifies on POSIX that `directory` is a real non-symlink directory (never following a link)
 * whose inode matches `expected`.
 */
export function verifyDirectoryIdentityNoFollow(directory: string, expected: Stats): void {
  if (process.platform === 'win32') return;
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(directory, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR' || code === 'ENOENT') {
      throw unsafePrivateDirectoryError(
        directory,
        'Private directory could not be verified safely.',
      );
    }
    throw error;
  }
  try {
    const fstat = fs.fstatSync(fd);
    if (!fstat.isDirectory() || fstat.dev !== expected.dev || fstat.ino !== expected.ino) {
      throw unsafePrivateDirectoryError(directory, 'Private directory changed while verifying.');
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Creates `childName` directly inside an already-existing `parentDir` with `0o700` on POSIX
 * without modifying any pre-existing directory's permissions.
 */
export function ensurePrivateChildDirectorySync(parentDir: string, childName: string): void {
  const parent = path.resolve(parentDir);
  const level = path.join(parent, childName);
  if (process.platform === 'win32') {
    const existing = lstatIfPresent(level);
    if (existing) {
      if (!existing.isDirectory()) {
        throw unsafePrivateDirectoryError(level, 'Expected a directory.');
      }
      return;
    }
    try {
      fs.mkdirSync(level, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return;
  }
  ensurePrivateChildWithAncestrySync(parent, childName);
}

/**
 * Creates missing directory levels privately (`0o700` on POSIX) without modifying any
 * pre-existing directory's permissions, waiting for or refusing incomplete concurrent initialization.
 * Does not restrict Windows ACLs (POSIX-only privacy model per `docs/agents/security.md`).
 */
export function ensurePrivateDirectorySync(
  directory: string,
  options?: { allowOwnedSymlinks?: boolean },
): void {
  const resolved = path.resolve(directory);
  if (process.platform === 'win32') {
    if (lstatIfPresent(resolved)) return;
    const parent = path.dirname(resolved);
    if (parent !== resolved && !lstatIfPresent(parent)) {
      ensurePrivateDirectorySync(parent, options);
    }
    try {
      fs.mkdirSync(resolved, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return;
  }
  ensurePrivateDirectoryWithAncestrySync(resolved, options);
}

function unsafePrivateDirectoryError(directory: string, detail: string): AppError {
  return new PrivateDirectoryUnsafeError('COMMAND_FAILED', `${detail} (${directory})`, {
    path: directory,
  });
}
