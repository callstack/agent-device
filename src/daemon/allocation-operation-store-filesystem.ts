import fs from 'node:fs';
import path from 'node:path';
import {
  syncDirectoryBestEffort,
  withAtomicPublishTempPathSync,
} from '@agent-device/host-kit/file';
import type { AllocationOperationRecord } from './allocation-operation-record.ts';

export function publishAllocationRecord(
  recordPath: string,
  record: AllocationOperationRecord,
  mode: 'replace' | 'link-exclusive',
): void {
  const directory = path.dirname(recordPath);
  withAtomicPublishTempPathSync(recordPath, (temporaryPath) => {
    assertSafeDestination(recordPath);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      assertSafeDestination(recordPath);
      if (mode === 'link-exclusive') fs.linkSync(temporaryPath, recordPath);
      else fs.renameSync(temporaryPath, recordPath);
      syncDirectoryBestEffort(directory);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  });
}

export function listAllocationOperationPaths(allocationsDir: string): string[] {
  let lanes: fs.Dirent[];
  try {
    lanes = fs.readdirSync(allocationsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const lane of lanes) {
    if (!lane.isDirectory() || lane.name.endsWith('.lane.lock')) continue;
    const lanePath = path.join(allocationsDir, lane.name);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(lanePath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.endsWith('.json')) paths.push(path.join(lanePath, entry.name));
    }
  }
  return paths.sort();
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

function assertSafeDestination(recordPath: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(recordPath);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  if (stats.isSymbolicLink())
    throw new Error('Refusing to replace an allocation operation symbolic link');
  if (!stats.isFile()) throw new Error('Refusing to replace a non-file allocation operation path');
}
