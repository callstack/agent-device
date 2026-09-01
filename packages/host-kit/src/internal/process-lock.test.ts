import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';

const { zombiePids } = vi.hoisted(() => ({ zombiePids: new Set<number>() }));

vi.mock('./host-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host-process.ts')>();
  return { ...actual, isProcessZombie: (pid: number) => zombiePids.has(pid) };
});

import { acquireProcessLock, type ProcessLockOwner } from './process-lock.ts';
import { readProcessStartTime } from './host-process.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempForTestSync('agent-device-process-lock-test-');
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

test('acquireProcessLock reclaims locks owned by zombie processes', async () => {
  const lockDirPath = path.join(tmpDir, 'zombie.lock');
  fs.mkdirSync(lockDirPath);
  // The owner passes kill(pid, 0) and matches its recorded start time; only
  // the zombie state reveals it already terminated.
  fs.writeFileSync(path.join(lockDirPath, 'owner.json'), JSON.stringify(currentProcessOwner()));
  zombiePids.add(process.pid);

  try {
    const release = await acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 3_000,
      pollMs: 1,
    });
    await release();
    assert.equal(fs.existsSync(lockDirPath), false);
  } finally {
    zombiePids.delete(process.pid);
  }
});

test('acquireProcessLock never steals a null-start-time lock from an alive pid', async () => {
  const lockDirPath = path.join(tmpDir, 'null-start.lock');
  fs.mkdirSync(lockDirPath);
  // An acquiredAtMs far older than this process simulates what a wall-clock
  // step makes a live null-start owner look like; age is not proof of death,
  // so the waiter must time out instead of reclaiming the held lock.
  fs.writeFileSync(
    path.join(lockDirPath, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      startTime: null,
      acquiredAtMs: Date.now() - 365 * 24 * 60 * 60_000,
    }),
  );

  await assert.rejects(
    () =>
      acquireProcessLock({
        lockDirPath,
        owner: currentProcessOwner(),
        timeoutMs: 50,
        pollMs: 1,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.ownerLiveness, 'live');
      return true;
    },
  );
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
      assert.equal(error.details?.ownerLiveness, 'live');
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
