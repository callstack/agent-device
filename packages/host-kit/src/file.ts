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

export class PrivateDirectoryUnsafeError extends AppError {}

export class PrivateDirectoryInitializingError extends AppError {}

/** Identifies the current output at a path. Directory identity stays stable as entries change. */
export function outputFileIdentity(stat: Stats): string {
  const inode = `${stat.dev}:${stat.ino}`;
  return stat.isDirectory() ? inode : `${inode}:${stat.size}:${stat.mtimeMs}`;
}

const PRIVATE_DIR_MODE = 0o700;
const DIR_INIT_WAIT_DELAY_MS = 10;
const DIR_INIT_WAIT_ATTEMPTS = 15;
const DIR_INIT_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/**
 * Verifies on POSIX that `directory` is a real non-symlink directory (never following a link)
 * whose inode matches `expected`. Returns `true` when openable without symlink dereference.
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
  ensurePrivateDirectoryLevelPosix(level, parent);
}

/**
 * Creates missing directory levels privately (`0o700` on POSIX) without modifying any
 * pre-existing directory's permissions, waiting for or refusing incomplete concurrent initialization.
 * Does not restrict Windows ACLs (POSIX-only privacy model per `docs/agents/security.md`).
 */
export function ensurePrivateDirectorySync(directory: string): void {
  const resolved = path.resolve(directory);
  if (process.platform === 'win32') {
    if (lstatIfPresent(resolved)) return;
    const parent = path.dirname(resolved);
    if (parent !== resolved && !lstatIfPresent(parent)) {
      ensurePrivateDirectorySync(parent);
    }
    try {
      fs.mkdirSync(resolved, { mode: PRIVATE_DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    return;
  }

  const missing: string[] = [];
  let cursor = resolved;
  let ancestorStat = lstatIfPresent(cursor);
  while (!ancestorStat) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    missing.push(cursor);
    cursor = parent;
    ancestorStat = lstatIfPresent(cursor);
  }

  if (ancestorStat) {
    assertSafeExistingDirectoryPosix(cursor, ancestorStat, missing.length > 0);
  }

  let parent = cursor;
  for (const level of missing.reverse()) {
    ensurePrivateDirectoryLevelPosix(level, parent);
    parent = level;
  }
}

function assertSafeExistingDirectoryPosix(
  directory: string,
  stats: Stats,
  allowRootSymlink: boolean,
): Stats {
  if (stats.isSymbolicLink()) {
    // Allow OS-level root aliases such as `/tmp` and `/var` on macOS when resolving above them,
    // while refusing any symlink at the target itself or created by non-root users.
    if (!allowRootSymlink || stats.uid !== 0) {
      throw unsafePrivateDirectoryError(
        directory,
        'Refusing symbolic link in private directory path.',
      );
    }
    const target = fs.statSync(directory);
    if (!target.isDirectory()) {
      throw unsafePrivateDirectoryError(directory, 'Expected a directory.');
    }
    return target;
  }
  if (!stats.isDirectory()) {
    throw unsafePrivateDirectoryError(directory, 'Expected a directory.');
  }
  const ready = waitForDirectoryOwnerBits(directory, stats);
  if ((ready.mode & PRIVATE_DIR_MODE) !== PRIVATE_DIR_MODE) {
    throw new PrivateDirectoryInitializingError(
      'COMMAND_FAILED',
      `Private directory ${directory} does not grant owner read/write/execute permissions yet.`,
      {
        retriable: true,
        path: directory,
      },
    );
  }
  verifyDirectoryIdentityNoFollow(directory, ready);
  return ready;
}

function ensurePrivateDirectoryLevelPosix(level: string, parent: string): void {
  const before = lstatIfPresent(level);
  if (before) {
    assertSafeExistingDirectoryPosix(level, before, false);
    return;
  }
  let created = false;
  try {
    fs.mkdirSync(level, { mode: PRIVATE_DIR_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const current = lstatIfPresent(level);
  if (!current || current.isSymbolicLink() || !current.isDirectory()) {
    throw unsafePrivateDirectoryError(
      level,
      'Private directory path changed or is not a directory.',
    );
  }
  if (!created) {
    assertSafeExistingDirectoryPosix(level, current, false);
    return;
  }
  finalizeCreatedPrivateDirectoryPosix(level, parent, current);
}

function finalizeCreatedPrivateDirectoryPosix(
  level: string,
  parent: string,
  createdStat: Stats,
): void {
  const mode = createdStat.mode & 0o777;
  if (mode === PRIVATE_DIR_MODE) {
    verifyDirectoryIdentityNoFollow(level, createdStat);
    return;
  }
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  if ((mode & 0o400) !== 0) {
    const fd = fs.openSync(level, flags);
    try {
      const fstat = fs.fstatSync(fd);
      if (!fstat.isDirectory() || fstat.dev !== createdStat.dev || fstat.ino !== createdStat.ino) {
        throw unsafePrivateDirectoryError(
          level,
          'Created directory changed before hardening mode.',
        );
      }
      fs.fchmodSync(fd, PRIVATE_DIR_MODE);
    } finally {
      fs.closeSync(fd);
    }
    return;
  }
  // Umask 0o700 leaves a new directory 0o000 without owner read access, so open(O_RDONLY) fails with
  // EACCES; verify parent privacy and matching inode first, chmod once, then verify the opened handle.
  const parentStat = fs.lstatSync(parent);
  if (
    parentStat.isSymbolicLink() ||
    !parentStat.isDirectory() ||
    ((parentStat.mode & 0o022) !== 0 && (parentStat.mode & 0o1000) === 0)
  ) {
    throw unsafePrivateDirectoryError(level, 'Unsafe parent while hardening new directory.');
  }
  const latest = lstatIfPresent(level);
  if (
    !latest ||
    latest.isSymbolicLink() ||
    !latest.isDirectory() ||
    latest.dev !== createdStat.dev ||
    latest.ino !== createdStat.ino
  ) {
    throw unsafePrivateDirectoryError(level, 'Created directory changed before hardening mode.');
  }
  fs.chmodSync(level, PRIVATE_DIR_MODE);
  verifyDirectoryIdentityNoFollow(level, createdStat);
}

function waitForDirectoryOwnerBits(directory: string, initial: Stats): Stats {
  let current = initial;
  for (let attempt = 0; attempt < DIR_INIT_WAIT_ATTEMPTS; attempt += 1) {
    if ((current.mode & PRIVATE_DIR_MODE) === PRIVATE_DIR_MODE) return current;
    Atomics.wait(DIR_INIT_SLEEP_BUFFER, 0, 0, DIR_INIT_WAIT_DELAY_MS);
    const next = lstatIfPresent(directory);
    if (!next || next.isSymbolicLink() || !next.isDirectory()) return current;
    current = next;
  }
  return current;
}

function unsafePrivateDirectoryError(directory: string, detail: string): AppError {
  return new PrivateDirectoryUnsafeError('COMMAND_FAILED', `${detail} (${directory})`, {
    path: directory,
  });
}
