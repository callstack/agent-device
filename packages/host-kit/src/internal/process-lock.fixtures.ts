import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import { readProcessStartTime } from './host-process.ts';
import type { ProcessLockOwner, ProcessLockOwnerRecord } from './process-lock.ts';

export function writeLockOwnerFixture(
  lockDirPath: string,
  owner: ProcessLockOwner | ProcessLockOwnerRecord,
): void {
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(path.join(lockDirPath, 'owner.json'), JSON.stringify(owner));
}

export function writeDeadLockFixture(lockDirPath: string, acquiredAtMs = Date.now()): void {
  writeLockOwnerFixture(lockDirPath, { pid: 999_999_999, startTime: null, acquiredAtMs });
}

export function failUnlinkForPath(filePath: string, error: Error) {
  const unlink = fs.unlinkSync;
  return vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
    if (String(target) === filePath) throw error;
    return unlink(target);
  });
}

export function currentProcessOwner(): ProcessLockOwner {
  return {
    pid: process.pid,
    startTime: readProcessStartTime(process.pid),
    acquiredAtMs: Date.now(),
  };
}

export function stampDirectoryAbandoned(directory: string): void {
  const abandoned = new Date(Date.now() - 60_000);
  fs.utimesSync(directory, abandoned, abandoned);
}

/** A reclaim that finishes leaves neither a parked directory nor a mutex behind. */
export function listReclaimSiblings(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.includes('.reclaim'))
    .sort();
}

/** Runs `action` the first time a contender opens the guard file, before the open itself. */
export function onFirstGuardOpen(mutexPath: string, action: () => void) {
  let fired = false;
  const realOpen = fs.openSync;
  const spy = vi.spyOn(fs, 'openSync').mockImplementation(((
    target: fs.PathLike,
    flags: fs.OpenMode,
    mode?: fs.Mode,
  ) => {
    if (String(target) === mutexPath && !fired) {
      fired = true;
      action();
    }
    return realOpen(target, flags, mode);
  }) as typeof fs.openSync);
  return { fired: () => fired, restore: () => spy.mockRestore() };
}

export const UNINFORMATIVE_OWNER_RECORDS = [
  '{ pid: ',
  'null',
  '"999999999"',
  '{"pid":"999999999","startTime":null,"acquiredAtMs":1}',
  '{"pid":0,"startTime":null,"acquiredAtMs":1}',
  '{"pid":999999999,"startTime":7,"acquiredAtMs":1}',
  '{"pid":999999999,"startTime":null}',
] as const;

function failRenameForPath(filePath: string, error: Error) {
  const rename = fs.renameSync;
  return vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(destination) === filePath) throw error;
    return rename(source, destination);
  });
}

export function failLockOwnerPublication(lockDirPath: string, releaseFails: boolean) {
  const primary = Object.assign(new Error('publication failed'), { code: 'EIO' });
  const releaseError = Object.assign(new Error('guard unlink refused'), { code: 'EPERM' });
  const renameSpy = failRenameForPath(path.join(lockDirPath, 'owner.json'), primary);
  const guardPath = lockDirPath.replace(/\.lock$/, '.reclaim.lock');
  const unlinkSpy = releaseFails ? failUnlinkForPath(guardPath, releaseError) : undefined;
  return { primary, renameSpy, unlinkSpy, guardPath };
}
