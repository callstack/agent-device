import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import * as diagnostics from './diagnostics.ts';

const { zombiePids, processProbe } = vi.hoisted(() => ({
  zombiePids: new Set<number>(),
  processProbe: { observe: undefined as (() => void) | undefined },
}));

vi.mock('./host-process.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./host-process.ts')>();
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
  };
});

import {
  acquireProcessLock,
  acquireProcessLockAcquisition,
  tryAcquireProcessLock,
  inspectProcessLock,
  withProcessLock,
  type ProcessLockRelease,
} from './process-lock.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { holdLegacyReclaimMutex } from './legacy-process-lock.fixtures.ts';
import {
  currentProcessOwner,
  failLockOwnerPublication,
  UNINFORMATIVE_OWNER_RECORDS,
  failUnlinkForPath,
  listReclaimSiblings,
  onFirstGuardOpen,
  stampDirectoryAbandoned,
  writeDeadLockFixture,
  writeLockOwnerFixture,
} from './process-lock.fixtures.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempForTestSync('agent-device-process-lock-test-');
});

afterEach(() => {
  processProbe.observe = undefined;
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
  writeDeadLockFixture(lockDirPath, Date.now() - 10_000);

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

test('acquireProcessLock reports live lock owner details on timeout', async () => {
  const lockDirPath = path.join(tmpDir, 'busy.lock');
  const owner = currentProcessOwner();
  writeLockOwnerFixture(lockDirPath, owner);

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

test('release leaves a lock whose record names a different process', async () => {
  const lockDirPath = path.join(tmpDir, 'taken-over.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
  });

  // A contender that reclaimed this lock while we were away republished the record
  // with its own identity; removing the directory would give away its lock.
  fs.writeFileSync(
    ownerFilePath,
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  await release();
  assert.equal(fs.existsSync(ownerFilePath), true);
});

test('release leaves a lock that a new acquisition of the same process republished', async () => {
  const lockDirPath = path.join(tmpDir, 'reacquired.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  const owner = currentProcessOwner();
  const release = await acquireProcessLock({ lockDirPath, owner });

  // Same pid, same start time: the only thing that can tell this record from ours is the
  // claim written with it. Removing the directory would hand the new holder's lock away.
  fs.writeFileSync(
    ownerFilePath,
    JSON.stringify({ ...owner, acquiredAtMs: Date.now(), claimToken: 'a-different-claim' }),
  );
  await release();

  assert.equal(
    (JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as { claimToken: string }).claimToken,
    'a-different-claim',
  );
});

test('a reacquired lock publishes a claim that its predecessor cannot reuse', async () => {
  const lockDirPath = path.join(tmpDir, 'claim-token.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  const first = await acquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  const firstToken = (JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as { claimToken: string })
    .claimToken;
  await first();

  const second = await acquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  const secondToken = (JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as { claimToken: string })
    .claimToken;
  await second();

  assert.equal(typeof firstToken, 'string');
  assert.equal(typeof secondToken, 'string');
  assert.notEqual(firstToken, secondToken);
});

test('acquireProcessLock does not evict an owner record it cannot read', async () => {
  const lockDirPath = path.join(tmpDir, 'unreadable.lock');
  fs.mkdirSync(lockDirPath);
  // A directory where the record belongs fails the read with EISDIR rather than
  // ENOENT, which is a live owner we know nothing about, not an unwritten one.
  fs.mkdirSync(path.join(lockDirPath, 'owner.json'));
  stampDirectoryAbandoned(lockDirPath);

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
      assert.equal(error.details?.ownerRecordUnreadable, true);
      return true;
    },
  );
  assert.equal(fs.existsSync(lockDirPath), true);
});

test('acquireProcessLock retains an owner whose record was never written', async () => {
  const lockDirPath = path.join(tmpDir, 'unpublished.lock');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  await assert.rejects(() =>
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 10,
      pollMs: 1,
    }),
  );
  assert.equal(fs.existsSync(lockDirPath), true);
});

test('one abandoned lock offered to two contenders is held by exactly one of them', async () => {
  const lockDirPath = path.join(tmpDir, 'contended.lock');
  writeDeadLockFixture(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  const attempts = await Promise.allSettled([
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 250,
      pollMs: 2,
    }),
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 250,
      pollMs: 2,
    }),
  ]);
  const acquired = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const refused = attempts.filter((attempt) => attempt.status === 'rejected');

  assert.equal(acquired.length, 1);
  assert.equal(refused.length, 1);
  const reason = (refused[0] as PromiseRejectedResult).reason;
  assert.ok(reason instanceof AppError);
  assert.equal(reason.details?.ownerLiveness, 'live');
  await (acquired[0] as PromiseFulfilledResult<() => Promise<void>>).value();
  assert.deepEqual(listReclaimSiblings(tmpDir), []);
});

for (const [index, record] of UNINFORMATIVE_OWNER_RECORDS.entries()) {
  test(`acquireProcessLock does not evict the lock behind the record ${record}`, async () => {
    const lockDirPath = path.join(tmpDir, `uninformative-${index}.lock`);
    fs.mkdirSync(lockDirPath);
    fs.writeFileSync(path.join(lockDirPath, 'owner.json'), record);
    stampDirectoryAbandoned(lockDirPath);

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
        assert.equal(error.details?.ownerRecordUnreadable, true);
        return true;
      },
    );
    assert.equal(fs.existsSync(lockDirPath), true);
  });
}

test('release reports a lock whose owner record it cannot read instead of clearing it', async () => {
  const lockDirPath = path.join(tmpDir, 'unverifiable-release.lock');
  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
  });
  fs.rmSync(path.join(lockDirPath, 'owner.json'));
  fs.mkdirSync(path.join(lockDirPath, 'owner.json'));

  await assert.rejects(
    () => release(),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.ownerReleaseUnverified, true);
      assert.match(String(error.details?.hint), /unverifiable-release\.lock/);
      return true;
    },
  );
  assert.equal(fs.existsSync(lockDirPath), true);
});

// A release that cannot verify ownership leaves its record standing under a claim this process has
// spent. The pid inside that record is this live process, so a reclaim that reads only the pid and
// its start time waits for a restart nothing is going to perform while every contender in here
// times out on a lock that is already free.
test('a release that could not verify ownership does not wedge the next acquire from this process', async () => {
  const lockDirPath = path.join(tmpDir, 'spent-claim.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  const release = await acquireProcessLock({ lockDirPath, owner: currentProcessOwner() });

  // The unlink the release needs is refused, which is what an EACCES or EMFILE looks like here.
  const unlinkSpy = failUnlinkForPath(
    ownerFilePath,
    Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' }),
  );
  try {
    await assert.rejects(
      () => release(),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.ownerReleaseUnverified, true);
        return true;
      },
    );
  } finally {
    unlinkSpy.mockRestore();
  }
  assert.equal(fs.existsSync(ownerFilePath), true);

  const next = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 1_000,
    pollMs: 5,
  });
  await next();
  assert.equal(fs.existsSync(lockDirPath), false);
});

// The spent-claim rule reads a record that names this process, so it has to know which copy of this
// module wrote it. Two bundles of `process-lock.ts` in one process share the pid and the start time,
// and neither can see the other's tokens; reading the other's live claim as spent would clear a lock
// somebody is holding, which is worse than the wait the rule exists to end.
test('a claim issued by another loading of this module is not read as spent', async () => {
  const lockDirPath = path.join(tmpDir, 'other-issuer.lock');
  writeLockOwnerFixture(lockDirPath, {
    ...currentProcessOwner(),
    claimToken: 'a-token-this-loading-never-issued',
    claimIssuerId: 'another-loading-of-this-module',
  });

  await assert.rejects(
    () =>
      acquireProcessLock({
        lockDirPath,
        owner: currentProcessOwner(),
        timeoutMs: 50,
        pollMs: 5,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.match(error.message, /Timed out waiting for/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
});

test('acquireProcessLock retains a legacy file at the lock path', async () => {
  const lockDirPath = path.join(tmpDir, 'legacy.lock');
  fs.writeFileSync(lockDirPath, '{"pid":999999999}');
  stampDirectoryAbandoned(lockDirPath);
  await assert.rejects(() =>
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 10,
      pollMs: 1,
    }),
  );
  assert.equal(fs.readFileSync(lockDirPath, 'utf8'), '{"pid":999999999}');
});

test('a contender that claims the path during a reclaim keeps its lock', async () => {
  const lockDirPath = path.join(tmpDir, 'claimed-during-reclaim.lock');
  const mutexPath = path.join(tmpDir, 'claimed-during-reclaim.reclaim.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  writeDeadLockFixture(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  // The moment a contender is admitted to judging this lock, another process clears the dead
  // claim and publishes its own. Nothing is removed: the record re-read under the mutex names a
  // claim token the dead one cannot answer to, and the judge walks away from the path.
  const guard = onFirstGuardOpen(mutexPath, () => {
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    fs.mkdirSync(lockDirPath);
    fs.writeFileSync(
      ownerFilePath,
      // A contender is another live process, and the pid has to say so: a record naming this
      // process with a token this process never issued is a spent claim, not a rival.
      JSON.stringify({
        pid: process.ppid,
        startTime: null,
        acquiredAtMs: Date.now(),
        claimToken: 'contender-claim',
      }),
    );
  });

  try {
    await assert.rejects(
      () =>
        acquireProcessLock({
          lockDirPath,
          owner: { pid: 999_999_998, startTime: null, acquiredAtMs: Date.now() },
          timeoutMs: 50,
          pollMs: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.ownerLiveness, 'live');
        assert.equal(error.details?.ownerPid, process.ppid);
        return true;
      },
    );
    assert.equal(guard.fired(), true);
    const record = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as {
      pid: number;
      claimToken: string;
    };
    assert.equal(record.pid, process.ppid);
    assert.equal(record.claimToken, 'contender-claim');
  } finally {
    guard.restore();
  }
});

// An abandoned directory with no record is the one thing this module deletes on age alone, so the
// two facts it re-checks under the mutex need their own witnesses: what is inside now, and how old
// the directory now is.
test('a claim published while a reclaim holds the mutex outlives the empty directory it filled', async () => {
  const lockDirPath = path.join(tmpDir, 'filled-during-reclaim.lock');
  const mutexPath = path.join(tmpDir, 'filled-during-reclaim.reclaim.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  // Writing the record is also what re-dates the directory, which is the fact the reclaim re-asks
  // for under its mutex before it removes anything.
  const guard = onFirstGuardOpen(mutexPath, () => {
    fs.writeFileSync(
      ownerFilePath,
      // See the contender above: another process's claim names another pid.
      JSON.stringify({
        pid: process.ppid,
        startTime: null,
        acquiredAtMs: Date.now(),
        claimToken: 'late-claim',
      }),
    );
  });

  try {
    await assert.rejects(
      () =>
        acquireProcessLock({
          lockDirPath,
          owner: { pid: 999_999_998, startTime: null, acquiredAtMs: Date.now() },
          timeoutMs: 50,
          pollMs: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.ownerLiveness, 'live');
        return true;
      },
    );
    assert.equal(guard.fired(), true);
    assert.equal(fs.existsSync(lockDirPath), true);
    const record = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as { claimToken: string };
    assert.equal(record.claimToken, 'late-claim');
  } finally {
    guard.restore();
  }
});

test('a lock directory made anew while a reclaim holds the mutex is not the one that was abandoned', async () => {
  const lockDirPath = path.join(tmpDir, 'refilled-during-reclaim.lock');
  const mutexPath = path.join(tmpDir, 'refilled-during-reclaim.reclaim.lock');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  // A replacement directory has a new identity and a fresh age.
  let refilledAtMs = 0;
  const guard = onFirstGuardOpen(mutexPath, () => {
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    fs.mkdirSync(lockDirPath);
    refilledAtMs = fs.statSync(lockDirPath).mtimeMs;
  });

  try {
    await assert.rejects(
      () =>
        acquireProcessLock({
          lockDirPath,
          owner: { pid: 999_999_998, startTime: null, acquiredAtMs: Date.now() },
          timeoutMs: 50,
          pollMs: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        return true;
      },
    );
    assert.equal(guard.fired(), true);
    assert.equal(
      fs.statSync(lockDirPath).mtimeMs,
      refilledAtMs,
      'the reclaim removed a directory it had not judged abandoned',
    );
  } finally {
    guard.restore();
  }
});

test('a reclaim mutex another contender holds leaves the abandoned lock standing', async () => {
  const lockDirPath = path.join(tmpDir, 'judged-by-another.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  fs.mkdirSync(lockDirPath);
  const staleClaim = { pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() };
  fs.writeFileSync(ownerFilePath, JSON.stringify(staleClaim));
  stampDirectoryAbandoned(lockDirPath);
  fs.mkdirSync(path.join(tmpDir, 'judged-by-another.reclaim.lock'));

  let lockAttempts = 0;
  const realOpen = fs.openSync;
  const guardSpy = vi.spyOn(fs, 'openSync').mockImplementation(((
    target: fs.PathLike,
    flags: fs.OpenMode,
    mode?: fs.Mode,
  ) => {
    if (String(target) === path.join(tmpDir, 'judged-by-another.reclaim.lock')) lockAttempts += 1;
    return realOpen(target, flags, mode);
  }) as typeof fs.openSync);

  try {
    await assert.rejects(
      () =>
        acquireProcessLock({
          lockDirPath,
          owner: { pid: 999_999_998, startTime: null, acquiredAtMs: Date.now() },
          timeoutMs: 50,
          pollMs: 1,
        }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.details?.ownerPid, 999_999_999);
        return true;
      },
    );
  } finally {
    guardSpy.mockRestore();
  }
  assert.ok(lockAttempts > 1, `contender polled ${lockAttempts} times`);
  assert.equal(fs.existsSync(ownerFilePath), true);
});

test('age alone never authorizes taking a publication or reclaim mutex', async () => {
  const lockDirPath = path.join(tmpDir, 'dead-janitor.lock');
  const mutexPath = path.join(tmpDir, 'dead-janitor.reclaim.lock');
  writeDeadLockFixture(lockDirPath);
  fs.mkdirSync(mutexPath);
  stampDirectoryAbandoned(lockDirPath);
  stampDirectoryAbandoned(mutexPath);

  await assert.rejects(() =>
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 10,
      pollMs: 1,
    }),
  );
  assert.equal(fs.existsSync(mutexPath), true);
});

test('a reclaim that cannot clear the lock directory leaves the record it judged', async () => {
  const lockDirPath = path.join(tmpDir, 'immovable.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  writeDeadLockFixture(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  const realRemove = fs.rmdirSync;
  const removeSpy = vi.spyOn(fs, 'rmdirSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target) !== lockDirPath) {
      return realRemove(target as string);
    }
    throw Object.assign(new Error('directory is busy'), { code: 'EBUSY' });
  }) as typeof fs.rmdirSync);

  try {
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
        assert.equal(error.details?.ownerPid, 999_999_999);
        return true;
      },
    );
    assert.equal(fs.existsSync(ownerFilePath), true);
  } finally {
    removeSpy.mockRestore();
  }
});

test('an abandoned lock with no record and something else inside is left alone', async () => {
  const lockDirPath = path.join(tmpDir, 'occupied.lock');
  const strangerPath = path.join(lockDirPath, 'not-a-record.json');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(strangerPath, 'nobody claims this');
  stampDirectoryAbandoned(lockDirPath);
  // Stamping the directory's own clocks back makes the stranger look older than the grace, too.
  fs.utimesSync(strangerPath, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

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
      return true;
    },
  );
  assert.equal(fs.existsSync(strangerPath), true);
});

test('withProcessLock gives the lock back on every path out of the task', async () => {
  const releases: string[] = [];
  const release: ProcessLockRelease = async () => {
    releases.push('released');
  };

  await withProcessLock({
    acquire: async () => release,
    task: async () => 'done',
  });
  await assert.rejects(
    () =>
      withProcessLock({
        acquire: async () => release,
        task: async () => {
          throw new Error('task failed');
        },
      }),
    /task failed/,
  );

  assert.deepEqual(releases, ['released', 'released']);
});

test('a task that failed is reported over a release that could not verify ownership', async () => {
  await assert.rejects(
    () =>
      withProcessLock({
        acquire: async () => async () => {
          throw new AppError('COMMAND_FAILED', 'Cannot verify ownership of device claim', {
            ownerReleaseUnverified: true,
          });
        },
        task: async () => {
          throw new Error('the write was rejected');
        },
      }),
    (error: unknown) => {
      assert.equal((error as Error).message, 'the write was rejected');
      return true;
    },
  );
});

test('a completed task still reports a lock it could not give back', async () => {
  await assert.rejects(
    () =>
      withProcessLock({
        acquire: async () => async () => {
          throw new AppError('COMMAND_FAILED', 'Cannot verify ownership of device claim', {
            ownerReleaseUnverified: true,
          });
        },
        task: async () => 'done',
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.ownerReleaseUnverified, true);
      return true;
    },
  );
});

test('one nonblocking attempt acquires, refuses a live claim, and invalidates its released handle', async () => {
  const lockDirPath = path.join(tmpDir, 'one-attempt.lock');
  const first = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  assert.equal(first.status, 'acquired');
  if (first.status !== 'acquired') throw new Error('first claim was refused');
  first.acquisition.assertHeld();
  assert.equal(tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() }).status, 'busy');
  await first.acquisition.release();
  assert.throws(() => first.acquisition.assertHeld(), /no longer held/);
  assert.deepEqual(inspectProcessLock(lockDirPath), { state: 'absent' });
});

test('bounded acquisition makes one attempt at zero timeout and carries mutation authority', async () => {
  const lockDirPath = path.join(tmpDir, 'bounded-authority.lock');
  const acquisition = await acquireProcessLockAcquisition({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 0,
  });
  acquisition.assertHeld();
  await assert.rejects(
    acquireProcessLockAcquisition({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 0,
    }),
  );
  await acquisition.release();
  assert.throws(() => acquisition.assertHeld());
});

test('a paused publisher retains exclusion after the old publication grace', async () => {
  const lockDirPath = path.join(tmpDir, 'paused-publication.lock');
  let contender: Promise<ProcessLockRelease> | undefined;
  let entered = false;
  const realMkdir = fs.mkdirSync;
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions,
  ) => {
    const value = realMkdir(target as string, options);
    if (String(target) === lockDirPath && !entered) {
      entered = true;
      stampDirectoryAbandoned(lockDirPath);
      contender = acquireProcessLock({
        lockDirPath,
        owner: currentProcessOwner(),
        timeoutMs: 10,
        pollMs: 1,
      });
    }
    return value;
  }) as typeof fs.mkdirSync);
  let owner: ProcessLockRelease;
  try {
    owner = await acquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
    await assert.rejects(contender!);
  } finally {
    mkdirSpy.mockRestore();
  }
  assert.equal(inspectProcessLock(lockDirPath).state, 'held');
  await owner!();
});

test('release after guarded private-directory removal never recreates it', async () => {
  const privateDir = path.join(tmpDir, 'private-replay');
  const attempt = tryAcquireProcessLock({
    lockDirPath: path.join(privateDir, 'daemon.lock'),
    owner: currentProcessOwner(),
  });
  if (attempt.status !== 'acquired') throw new Error('private claim was refused');
  attempt.acquisition.assertHeld();
  fs.rmSync(privateDir, { recursive: true });
  await attempt.acquisition.release();
  assert.equal(fs.existsSync(privateDir), false);
});

test('legacy reclaim cannot age-delete a paused publisher mutation guard', async () => {
  const lockDirPath = path.join(tmpDir, 'mixed-version.lock');
  const guard = path.join(tmpDir, 'mixed-version.reclaim.lock');
  const mkdir = fs.mkdirSync;
  let legacyAdmitted: boolean | undefined;
  const spy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions,
  ) => {
    const result = mkdir(target, options);
    if (String(target) === lockDirPath) {
      stampDirectoryAbandoned(guard);
      legacyAdmitted = holdLegacyReclaimMutex(guard, 5_000);
    }
    return result;
  }) as typeof fs.mkdirSync);
  let acquisition: ProcessLockRelease | undefined;
  try {
    acquisition = await acquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
    assert.equal(legacyAdmitted, false);
  } finally {
    spy.mockRestore();
    await acquisition?.();
  }
});

test('an acquisition cannot authorize a successor record', async () => {
  const lockDirPath = path.join(tmpDir, 'assertion.lock');
  const attempt = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  if (attempt.status !== 'acquired') throw new Error('first claim was refused');
  const ownerPath = path.join(lockDirPath, 'owner.json');
  const successor = { ...currentProcessOwner(), claimToken: 'successor' };
  fs.writeFileSync(ownerPath, JSON.stringify(successor));
  assert.throws(() => attempt.acquisition.assertHeld(), /no longer held/);
  await attempt.acquisition.release();
  assert.deepEqual(JSON.parse(fs.readFileSync(ownerPath, 'utf8')), successor);
});

for (const releaseFails of [false, true]) {
  test(`failed owner publication remains primary when guard release fails: ${releaseFails}`, async () => {
    const lockDirPath = path.join(tmpDir, 'failed-publication.lock');
    const faults = failLockOwnerPublication(lockDirPath, releaseFails);
    const diagnosticSpy = vi.spyOn(diagnostics, 'emitDiagnostic');
    try {
      assert.throws(
        () => tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() }),
        (error) => error === faults.primary,
      );
      if (releaseFails) {
        const data = diagnosticSpy.mock.calls.find(
          ([event]) => event.phase === 'process_lock_guard_release_failed',
        )?.[0].data;
        const failure = data?.error as ReturnType<typeof normalizeError>;
        assert.equal(failure.cause?.code, 'EPERM');
        assert.equal(failure.details?.reason, 'process_lock_guard_release_failed');
        assert.match(failure.hint ?? '', /confirming all users/);
        assert.equal(fs.existsSync(faults.guardPath), true);
      }
    } finally {
      faults.renameSpy.mockRestore();
      faults.unlinkSpy?.mockRestore();
      diagnosticSpy.mockRestore();
    }
    if (releaseFails) fs.unlinkSync(faults.guardPath);
    const retry = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
    assert.equal(retry.status, 'acquired');
    if (retry.status === 'acquired') await retry.acquisition.release();
  });
}

test('a failed guard release reports retained exclusion and supports verified manual recovery', async () => {
  const lockDirPath = path.join(tmpDir, 'guard-release.lock');
  const guardPath = path.join(tmpDir, 'guard-release.reclaim.lock');
  const primary = Object.assign(new Error('guard unlink refused'), { code: 'EPERM' });
  const unlinkSpy = failUnlinkForPath(guardPath, primary);
  try {
    assert.throws(
      () => tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'COMMAND_FAILED');
        assert.equal(error.details?.reason, 'process_lock_guard_release_failed');
        assert.equal(error.details?.lockDirPath, lockDirPath);
        assert.equal(error.cause, primary);
        const failure = normalizeError(error);
        assert.equal(failure.cause?.code, 'EPERM');
        assert.equal(
          failure.hint,
          `Restore process inspection or stop the verified owner, then retry. Remove ${lockDirPath} and ${guardPath} only after confirming all users of this state directory have stopped.`,
        );
        return true;
      },
    );
    assert.equal(fs.existsSync(guardPath), true);
    const ownerRecord = fs.readFileSync(path.join(lockDirPath, 'owner.json'), 'utf8');
    assert.equal(JSON.parse(ownerRecord).pid, process.pid);
    assert.equal(
      tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() }).status,
      'busy',
    );
    assert.equal(fs.readFileSync(path.join(lockDirPath, 'owner.json'), 'utf8'), ownerRecord);
  } finally {
    unlinkSpy.mockRestore();
  }
  fs.unlinkSync(guardPath);
  const retry = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  assert.equal(retry.status, 'acquired');
  if (retry.status === 'acquired') await retry.acquisition.release();
});

test('incomplete release preserves owner evidence and can be retried', async () => {
  const lockDirPath = path.join(tmpDir, 'partial-release.lock');
  const attempt = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  if (attempt.status !== 'acquired') throw new Error('first claim was refused');
  const realRmdir = fs.rmdirSync;
  const rmdirSpy = vi.spyOn(fs, 'rmdirSync').mockImplementation((target, options) => {
    if (String(target) === lockDirPath) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realRmdir(target, options);
  });
  try {
    await assert.rejects(attempt.acquisition.release(), /Cannot verify ownership/);
    assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
  } finally {
    rmdirSpy.mockRestore();
  }
  await attempt.acquisition.release();
  assert.equal(fs.existsSync(lockDirPath), false);
  const retry = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  assert.equal(retry.status, 'acquired');
  if (retry.status === 'acquired') await retry.acquisition.release();
});

test('release waits for a guard another process holds for a filesystem step', async () => {
  const lockDirPath = path.join(tmpDir, 'contended-release.lock');
  const mutexPath = path.join(tmpDir, 'contended-release.reclaim.lock');
  const acquisition = await acquireProcessLockAcquisition({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 0,
  });
  fs.writeFileSync(mutexPath, '');
  const releasing = acquisition.release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fs.existsSync(lockDirPath), true);
  assert.equal(fs.existsSync(mutexPath), true);
  fs.unlinkSync(mutexPath);
  await releasing;

  assert.equal(fs.existsSync(lockDirPath), false);
  const next = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  assert.equal(next.status, 'acquired');
  if (next.status === 'acquired') await next.acquisition.release();
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
