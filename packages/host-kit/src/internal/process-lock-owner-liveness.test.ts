import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';

const { zombiePids, processProbe } = vi.hoisted(() => ({
  zombiePids: new Set<number>(),
  processProbe: { observe: undefined as (() => void) | undefined },
}));

vi.mock('./host-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host-process.ts')>();
  const observe = (pids: Iterable<number>) => {
    const observations = new Map<number, { state: string; startTime: string }>();
    for (const pid of pids) {
      processProbe.observe?.();
      const startTime = actual.readProcessStartTime(pid);
      if (!zombiePids.has(pid) && startTime === null) continue;
      observations.set(pid, {
        state: zombiePids.has(pid) ? 'ZN' : 'Ss',
        startTime: startTime ?? 'zombie-snapshot',
      });
    }
    return observations;
  };
  return {
    ...actual,
    isProcessZombie: (pid: number) => {
      processProbe.observe?.();
      return zombiePids.has(pid);
    },
    readProcessStartTime: (pid: number) => {
      processProbe.observe?.();
      return actual.readProcessStartTime(pid);
    },
    // Classification judges from one snapshot; the fixture answers it from the
    // same zombie state and real start times as the per-field probes.
    readHostProcessIdentityObservations: observe,
    readHostProcessIdentityObservationsAsync: async (pids: Iterable<number>) => observe(pids),
  };
});

import { acquireProcessLock, tryAcquireProcessLock } from './process-lock.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { currentProcessOwner, writeLockOwnerFixture } from './process-lock.fixtures.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempForTestSync('agent-device-process-lock-liveness-');
});

afterEach(() => {
  processProbe.observe = undefined;
  fs.rmSync(tmpDir, { recursive: true, force: true });
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
  // An acquiredAtMs far older than this process simulates what a wall-clock
  // step makes a live null-start owner look like; age is not proof of death,
  // so the waiter must time out instead of reclaiming the held lock.
  writeLockOwnerFixture(lockDirPath, {
    pid: process.pid,
    startTime: null,
    acquiredAtMs: Date.now() - 365 * 24 * 60 * 60_000,
  });

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

test('a contender judges a live owner without holding the guard', async () => {
  const lockDirPath = path.join(tmpDir, 'probed-outside-guard.lock');
  const mutexPath = path.join(tmpDir, 'probed-outside-guard.reclaim.lock');
  writeLockOwnerFixture(lockDirPath, {
    pid: process.ppid,
    startTime: null,
    acquiredAtMs: Date.now(),
    claimToken: 'live-rival',
  });
  let probes = 0;
  let probesUnderGuard = 0;
  processProbe.observe = () => {
    probes += 1;
    if (fs.existsSync(mutexPath)) probesUnderGuard += 1;
  };

  const attempt = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });

  assert.equal(attempt.status, 'busy');
  assert.ok(probes > 0, 'the live owner was never probed');
  assert.equal(probesUnderGuard, 0);
  assert.equal(fs.existsSync(mutexPath), false);
});
