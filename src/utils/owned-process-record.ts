import fs from 'node:fs';
import path from 'node:path';
import type {
  OwnedProcessRecord,
  OwnedProcessRecordScope,
  OwnedProcessRecordWriter,
} from '@agent-device/contracts/platform';
import { withAtomicPublishTempPathSync } from './atomic-file.ts';

const RECORD_FILE_NAME = 'owned-processes.json';
const RECORD_VERSION = 1;

type OwnedProcessRecordFile = Readonly<{
  version: typeof RECORD_VERSION;
  processes: readonly OwnedProcessRecord[];
}>;

export type OwnedProcessRecordRead = Readonly<{
  scope: OwnedProcessRecordScope;
  path: string;
  status: 'decoded' | 'invalid';
  records: readonly OwnedProcessRecord[];
  message?: string;
}>;

export type OwnedProcessRecordStore = OwnedProcessRecordWriter &
  Readonly<{
    read(): readonly OwnedProcessRecordRead[];
  }>;

export function createOwnedProcessRecordStore(options: {
  stateDir: string;
  sessionsDir: string;
  resolveSessionDir(sessionId: string): string;
}): OwnedProcessRecordStore {
  const stateDir = path.resolve(options.stateDir);
  const sessionsDir = path.resolve(options.sessionsDir);
  const daemonPath = path.join(stateDir, RECORD_FILE_NAME);

  const resolvePath = (scope: OwnedProcessRecordScope): string => {
    if (scope.kind === 'daemon') return daemonPath;
    const sessionDir = path.resolve(options.resolveSessionDir(scope.sessionId));
    if (path.dirname(sessionDir) !== sessionsDir) {
      throw new TypeError(
        'owned process session scope must resolve directly under the sessions dir',
      );
    }
    return path.join(sessionDir, RECORD_FILE_NAME);
  };

  return Object.freeze({
    replace(scope, records) {
      const normalized = normalizeRecords(records);
      const recordPath = resolvePath(scope);
      if (normalized.length === 0) {
        clearRecordPath(recordPath);
        return;
      }
      const directory = path.dirname(recordPath);
      fs.mkdirSync(directory, { recursive: true });
      withAtomicPublishTempPathSync(recordPath, (temporaryPath) => {
        const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        try {
          fs.writeFileSync(
            descriptor,
            `${JSON.stringify({ version: RECORD_VERSION, processes: normalized })}\n`,
            'utf8',
          );
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        assertSafeRecordDestination(recordPath);
        fs.renameSync(temporaryPath, recordPath);
      });
    },
    clear(scope) {
      clearRecordPath(resolvePath(scope));
    },
    read() {
      return readRecordFiles(sessionsDir, daemonPath);
    },
  });
}

export function readOwnedProcessRecordFile(
  recordPath: string,
  scope: OwnedProcessRecordScope,
): OwnedProcessRecordRead {
  let value: unknown;
  try {
    assertSafeRecordDestination(recordPath);
    value = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as unknown;
  } catch (error) {
    return {
      scope,
      path: recordPath,
      status: 'invalid',
      records: [],
      message: errorMessage(error),
    };
  }
  if (!isRecordFile(value)) {
    return {
      scope,
      path: recordPath,
      status: 'invalid',
      records: [],
      message: 'owned process record must contain version 1 and a processes array',
    };
  }
  try {
    return {
      scope,
      path: recordPath,
      status: 'decoded',
      records: normalizeRecords(value.processes),
    };
  } catch (error) {
    return {
      scope,
      path: recordPath,
      status: 'invalid',
      records: [],
      message: errorMessage(error),
    };
  }
}

function readRecordFiles(sessionsDir: string, daemonPath: string): OwnedProcessRecordRead[] {
  const entries: OwnedProcessRecordRead[] = [];
  if (fileExists(daemonPath))
    entries.push(readOwnedProcessRecordFile(daemonPath, { kind: 'daemon' }));
  if (!fs.existsSync(sessionsDir)) return entries;
  for (const entry of fs
    .readdirSync(sessionsDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const recordPath = path.join(sessionsDir, entry.name, RECORD_FILE_NAME);
    if (fileExists(recordPath)) {
      entries.push(
        readOwnedProcessRecordFile(recordPath, { kind: 'session', sessionId: entry.name }),
      );
    }
  }
  return entries;
}

function normalizeRecords(records: readonly OwnedProcessRecord[]): OwnedProcessRecord[] {
  const seen = new Set<number>();
  const normalized: OwnedProcessRecord[] = [];
  for (const record of records) {
    if (!isValidOwnedProcessRecord(record)) {
      throw new TypeError('owned process record has an invalid identity or purpose');
    }
    if (seen.has(record.pid)) throw new TypeError(`duplicate owned process pid ${record.pid}`);
    seen.add(record.pid);
    normalized.push(
      Object.freeze({
        pid: record.pid,
        startTime: record.startTime,
        command: record.command,
        purpose: record.purpose,
      }),
    );
  }
  return normalized.sort((left, right) => left.pid - right.pid);
}

function isValidOwnedProcessRecord(record: OwnedProcessRecord): boolean {
  return (
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.startTime === 'string' &&
    record.startTime.length > 0 &&
    typeof record.command === 'string' &&
    record.command.length > 0 &&
    typeof record.purpose === 'string' &&
    record.purpose.length > 0
  );
}

function isRecordFile(value: unknown): value is OwnedProcessRecordFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === RECORD_VERSION &&
    'processes' in value &&
    Array.isArray(value.processes)
  );
}

function clearRecordPath(recordPath: string): void {
  try {
    assertSafeRecordDestination(recordPath);
    fs.unlinkSync(recordPath);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function assertSafeRecordDestination(recordPath: string): void {
  try {
    const stats = fs.lstatSync(recordPath);
    if (stats.isSymbolicLink())
      throw new Error('Refusing to follow an owned process record symlink');
    if (!stats.isFile()) throw new Error('Owned process record is not a regular file');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'owned process record is invalid';
}
