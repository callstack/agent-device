import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'vitest';
import { AppError } from '../../kernel/errors.ts';
import { acquireProcessLock, type ProcessLockOwner } from '../process-lock.ts';
import { readProcessStartTime } from '../process-identity.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-process-lock-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('acquireProcessLock creates and releases a lock directory', async () => {
  const lockDirPath = path.join(tmpDir, 'runner.lock');

  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
  });

  assert.equal(fs.existsSync(lockDirPath), true);
  await release();
  assert.equal(fs.existsSync(lockDirPath), false);
});

test('acquireProcessLock reclaims locks owned by dead processes', async () => {
  const lockDirPath = path.join(tmpDir, 'stale.lock');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    path.join(lockDirPath, 'owner.json'),
    JSON.stringify({
      pid: 999_999_999,
      startTime: null,
      acquiredAtMs: Date.now() - 10_000,
    }),
  );

  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 50,
    pollMs: 1,
  });

  assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
  await release();
  assert.equal(fs.existsSync(lockDirPath), false);
});

test('acquireProcessLock reports live lock owner details on timeout', async () => {
  const lockDirPath = path.join(tmpDir, 'busy.lock');
  fs.mkdirSync(lockDirPath);
  const owner = currentProcessOwner();
  fs.writeFileSync(path.join(lockDirPath, 'owner.json'), JSON.stringify(owner));

  await assert.rejects(
    () =>
      acquireProcessLock({
        lockDirPath,
        owner: currentProcessOwner(),
        timeoutMs: 5,
        pollMs: 1,
        description: 'busy test lock',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.message, 'Timed out waiting for busy test lock');
      assert.equal(error.details?.lockDirPath, lockDirPath);
      assert.equal(error.details?.ownerPid, process.pid);
      return true;
    },
  );
});

function currentProcessOwner(): ProcessLockOwner {
  return {
    pid: process.pid,
    startTime: readProcessStartTime(process.pid),
    acquiredAtMs: Date.now(),
  };
}
