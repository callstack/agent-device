import fs from 'node:fs';
import path from 'node:path';
import { publishDurableFileSync } from '@agent-device/host-kit/file';
import type { AllocationOperationRecord } from './record.ts';

export type AllocationOperationPath =
  | Readonly<{ status: 'path'; path: string }>
  | Readonly<{ status: 'unreadable'; path: string; message: string }>;

export function publishAllocationRecord(
  recordPath: string,
  record: AllocationOperationRecord,
  mode: 'replace' | 'link-exclusive',
): void {
  publishDurableFileSync({
    destination: recordPath,
    contents: `${JSON.stringify(record)}\n`,
    publish: mode,
  });
}

export function listAllocationOperationPaths(allocationsDir: string): AllocationOperationPath[] {
  const rootState = inspectDirectory(allocationsDir);
  if (rootState === 'missing') return [];
  if (rootState !== null) return [unreadablePath(allocationsDir, rootState)];

  const lanes = readDirectory(allocationsDir);
  if (lanes.status === 'missing') return [];
  if (lanes.status === 'unreadable') return [unreadablePath(allocationsDir, lanes.message)];
  return lanes.entries
    .flatMap((lane) => listLanePaths(allocationsDir, lane))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function isAlreadyExists(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

export function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'allocation operation record is unreadable';
}

export function assertSafeAllocationDirectory(directory: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing unsafe allocation operation directory ${directory}`);
  }
}

export function inspectAllocationOperationDirectories(
  recordPath: string,
): 'missing' | string | null {
  const laneDirectory = path.dirname(recordPath);
  const directories = [path.dirname(laneDirectory), laneDirectory];
  for (const directory of directories) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(directory);
    } catch (error) {
      if (isMissingFile(error)) return 'missing';
      return errorMessage(error);
    }
    if (stats.isSymbolicLink()) return 'allocation operation directory is a symbolic link';
    if (!stats.isDirectory()) return 'allocation operation directory is not a directory';
  }
  return null;
}

function inspectDirectory(directory: string): 'missing' | string | null {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch (error) {
    return isMissingFile(error) ? 'missing' : errorMessage(error);
  }
  if (stats.isSymbolicLink()) return 'allocation operation directory is a symbolic link';
  if (!stats.isDirectory()) return 'allocation operation directory is not a directory';
  return null;
}

type DirectoryRead =
  | Readonly<{ status: 'entries'; entries: fs.Dirent[] }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'unreadable'; message: string }>;

function readDirectory(directory: string): DirectoryRead {
  try {
    return { status: 'entries', entries: fs.readdirSync(directory, { withFileTypes: true }) };
  } catch (error) {
    return isMissingFile(error)
      ? { status: 'missing' }
      : { status: 'unreadable', message: errorMessage(error) };
  }
}

function listLanePaths(allocationsDir: string, lane: fs.Dirent): AllocationOperationPath[] {
  if (lane.name.endsWith('.lane.lock')) return [];
  const lanePath = path.join(allocationsDir, lane.name);
  if (!lane.isDirectory()) {
    return [
      unreadablePath(
        lanePath,
        lane.isSymbolicLink()
          ? 'allocation operation lane is a symbolic link'
          : 'allocation operation lane is not a directory',
      ),
    ];
  }
  const entries = readDirectory(lanePath);
  if (entries.status === 'missing') return [];
  if (entries.status === 'unreadable') return [unreadablePath(lanePath, entries.message)];
  return entries.entries
    .filter((entry) => entry.name.endsWith('.json'))
    .map((entry) => ({ status: 'path', path: path.join(lanePath, entry.name) }));
}

function unreadablePath(pathname: string, message: string): AllocationOperationPath {
  return { status: 'unreadable', path: pathname, message };
}
