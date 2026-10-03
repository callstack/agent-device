import fs from 'node:fs';
import { vi } from 'vitest';
import { readProcessStartTime } from './host-process.ts';
import type { ProcessLockOwner } from './process-lock.ts';

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
