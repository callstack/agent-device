import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../kernel/errors.ts';
import { isProcessAlive, readProcessStartTime } from './process-identity.ts';
import { sleep } from './timeouts.ts';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 100;
const DEFAULT_LOCK_OWNER_GRACE_MS = 5_000;

export type ProcessLockOwner = {
  pid: number;
  startTime: string | null;
  acquiredAtMs: number;
};

export async function acquireProcessLock(params: {
  lockDirPath: string;
  owner: ProcessLockOwner;
  timeoutMs?: number;
  pollMs?: number;
  ownerGraceMs?: number;
  description?: string;
}): Promise<() => Promise<void>> {
  const { lockDirPath, owner } = params;
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  const deadline = Date.now() + (params.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = params.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const ownerGraceMs = params.ownerGraceMs ?? DEFAULT_LOCK_OWNER_GRACE_MS;
  const description = params.description ?? 'process lock';

  fs.mkdirSync(path.dirname(lockDirPath), { recursive: true });

  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDirPath);
      writeProcessLockOwner(ownerFilePath, owner);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        fs.rmSync(lockDirPath, { recursive: true, force: true });
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') {
        throw err;
      }
      if (clearStaleProcessLock(lockDirPath, ownerFilePath, ownerGraceMs)) {
        continue;
      }
      await sleep(pollMs);
    }
  }

  throw new AppError('COMMAND_FAILED', `Timed out waiting for ${description}`, {
    lockDirPath,
    ...readProcessLockDiagnostics(lockDirPath, ownerFilePath),
  });
}

function writeProcessLockOwner(ownerFilePath: string, owner: ProcessLockOwner): void {
  const tmpOwnerFilePath = `${ownerFilePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpOwnerFilePath, JSON.stringify(owner), 'utf8');
  fs.renameSync(tmpOwnerFilePath, ownerFilePath);
}

function clearStaleProcessLock(
  lockDirPath: string,
  ownerFilePath: string,
  ownerGraceMs: number,
): boolean {
  let ownerStats: fs.Stats | null = null;
  try {
    ownerStats = fs.statSync(lockDirPath);
  } catch {
    return true;
  }

  const owner = readProcessLockOwner(ownerFilePath);
  if (owner) {
    if (isLiveProcessLockOwner(owner)) {
      return false;
    }
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    return true;
  }
  if (Date.now() - ownerStats.mtimeMs < ownerGraceMs) {
    return false;
  }
  fs.rmSync(lockDirPath, { recursive: true, force: true });
  return true;
}

function readProcessLockOwner(ownerFilePath: string): ProcessLockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as ProcessLockOwner;
  } catch {
    return null;
  }
}

function readProcessLockDiagnostics(
  lockDirPath: string,
  ownerFilePath: string,
): Record<string, unknown> {
  const nowMs = Date.now();
  const owner = readProcessLockOwner(ownerFilePath);
  let lockAgeMs: number | undefined;
  try {
    lockAgeMs = Math.max(0, Math.round(nowMs - fs.statSync(lockDirPath).mtimeMs));
  } catch {}
  return {
    ...(lockAgeMs !== undefined ? { lockAgeMs } : {}),
    ...(owner
      ? {
          ownerPid: owner.pid,
          ownerStartTime: owner.startTime,
          ownerAgeMs: Math.max(0, Math.round(nowMs - owner.acquiredAtMs)),
        }
      : {}),
  };
}

function isLiveProcessLockOwner(owner: ProcessLockOwner): boolean {
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  if (!isProcessAlive(owner.pid)) {
    return false;
  }
  if (owner.startTime) {
    return readProcessStartTime(owner.pid) === owner.startTime;
  }
  return true;
}
