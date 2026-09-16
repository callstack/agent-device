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

import {
  acquireProcessLock,
  withProcessLock,
  type ProcessLockOwner,
  type ProcessLockRelease,
} from './process-lock.ts';
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

test('acquireProcessLock reclaims a lock whose owner record was never written', async () => {
  const lockDirPath = path.join(tmpDir, 'unpublished.lock');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 500,
    pollMs: 1,
  });
  await release();
  assert.equal(fs.existsSync(lockDirPath), false);
});

// The grace is a second in the future rather than zero: an abandoned mutex is what a zero grace
// would say about the mutex the winner holds, and this test would then be measuring a reclaim
// that skipped it. What the mutex itself is worth is the two mutex tests further down.
test('one abandoned lock offered to two contenders is held by exactly one of them', async () => {
  const lockDirPath = path.join(tmpDir, 'contended.lock');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  const attempts = await Promise.allSettled([
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      ownerGraceMs: 1_000,
      timeoutMs: 250,
      pollMs: 2,
    }),
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      ownerGraceMs: 1_000,
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

/** A reclaim that finishes leaves neither a parked directory nor a mutex behind. */
function listReclaimSiblings(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.includes('.reclaim'))
    .sort();
}

const UNINFORMATIVE_OWNER_RECORDS = [
  '{ pid: ',
  'null',
  '"999999999"',
  '{"pid":"999999999","startTime":null,"acquiredAtMs":1}',
  '{"pid":0,"startTime":null,"acquiredAtMs":1}',
  '{"pid":999999999,"startTime":7,"acquiredAtMs":1}',
  '{"pid":999999999,"startTime":null}',
] as const;

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
  const realUnlink = fs.unlinkSync;
  const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target) === ownerFilePath) {
      throw Object.assign(new Error('EACCES: permission denied, unlink'), { code: 'EACCES' });
    }
    return realUnlink(target as string);
  }) as typeof fs.unlinkSync);
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
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    path.join(lockDirPath, 'owner.json'),
    JSON.stringify({
      ...currentProcessOwner(),
      claimToken: 'a-token-this-loading-never-issued',
      claimIssuerId: 'another-loading-of-this-module',
    }),
  );

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

test('acquireProcessLock reclaims a stray path in place of the lock directory', async () => {
  const lockDirPath = path.join(tmpDir, 'stray.lock');
  fs.writeFileSync(lockDirPath, 'not a lock');
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDirPath, stale, stale);

  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 500,
    pollMs: 1,
  });
  await release();
  assert.equal(fs.existsSync(lockDirPath), false);
});

test('a contender that claims the path during a reclaim keeps its lock', async () => {
  const lockDirPath = path.join(tmpDir, 'claimed-during-reclaim.lock');
  const mutexPath = path.join(tmpDir, 'claimed-during-reclaim.reclaim.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    ownerFilePath,
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  stampDirectoryAbandoned(lockDirPath);

  // The moment a contender is admitted to judging this lock, another process clears the dead
  // claim and publishes its own. Nothing is removed: the record re-read under the mutex names a
  // claim token the dead one cannot answer to, and the judge walks away from the path.
  let claimed = false;
  const realMkdir = fs.mkdirSync;
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions & { recursive: true },
  ) => {
    if (String(target) !== mutexPath || claimed) {
      return realMkdir(target as string, options as fs.MakeDirectoryOptions);
    }
    claimed = true;
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
    return realMkdir(target as string, options as fs.MakeDirectoryOptions);
  }) as typeof fs.mkdirSync);

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
    assert.equal(claimed, true);
    const record = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as {
      pid: number;
      claimToken: string;
    };
    assert.equal(record.pid, process.ppid);
    assert.equal(record.claimToken, 'contender-claim');
  } finally {
    mkdirSpy.mockRestore();
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
  let published = false;
  const realMkdir = fs.mkdirSync;
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions & { recursive: true },
  ) => {
    if (String(target) !== mutexPath || published) {
      return realMkdir(target as string, options as fs.MakeDirectoryOptions);
    }
    published = true;
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
    return realMkdir(target as string, options as fs.MakeDirectoryOptions);
  }) as typeof fs.mkdirSync);

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
    assert.equal(published, true);
    assert.equal(fs.existsSync(lockDirPath), true);
    const record = JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as { claimToken: string };
    assert.equal(record.claimToken, 'late-claim');
  } finally {
    mkdirSpy.mockRestore();
  }
});

test('a lock directory made anew while a reclaim holds the mutex is not the one that was abandoned', async () => {
  const lockDirPath = path.join(tmpDir, 'refilled-during-reclaim.lock');
  const mutexPath = path.join(tmpDir, 'refilled-during-reclaim.reclaim.lock');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  // Replacing the directory rather than filling it is what a contender that won the path looks
  // like from the inside: same name, same emptiness, and an age that says it was never abandoned.
  let replaced = false;
  let refilledAtMs = 0;
  const realMkdir = fs.mkdirSync;
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions & { recursive: true },
  ) => {
    if (String(target) !== mutexPath || replaced) {
      return realMkdir(target as string, options as fs.MakeDirectoryOptions);
    }
    replaced = true;
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    fs.mkdirSync(lockDirPath);
    refilledAtMs = fs.statSync(lockDirPath).mtimeMs;
    return realMkdir(target as string, options as fs.MakeDirectoryOptions);
  }) as typeof fs.mkdirSync);

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
    assert.equal(replaced, true);
    assert.equal(
      fs.statSync(lockDirPath).mtimeMs,
      refilledAtMs,
      'the reclaim removed a directory it had not judged abandoned',
    );
  } finally {
    mkdirSpy.mockRestore();
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

  // Nobody may judge this lock twice, and a contender that cannot say so keeps polling
  // rather than clearing what it has not finished reading. The grace is the default five seconds,
  // so the mutex this test placed is held rather than abandoned.
  let lockAttempts = 0;
  const realMkdir = fs.mkdirSync;
  const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(((
    target: fs.PathLike,
    options?: fs.MakeDirectoryOptions & { recursive: true },
  ) => {
    if (String(target) === lockDirPath) lockAttempts += 1;
    return realMkdir(target as string, options as fs.MakeDirectoryOptions);
  }) as typeof fs.mkdirSync);

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
    mkdirSpy.mockRestore();
  }
  assert.ok(lockAttempts > 1, `contender polled ${lockAttempts} times`);
  assert.equal(fs.existsSync(ownerFilePath), true);
});

test('a reclaim mutex left behind by a dead process is cleared by age', async () => {
  const lockDirPath = path.join(tmpDir, 'dead-janitor.lock');
  const mutexPath = path.join(tmpDir, 'dead-janitor.reclaim.lock');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    path.join(lockDirPath, 'owner.json'),
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  fs.mkdirSync(mutexPath);
  stampDirectoryAbandoned(lockDirPath);
  stampDirectoryAbandoned(mutexPath);

  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 500,
    pollMs: 1,
  });

  assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
  assert.equal(fs.existsSync(mutexPath), false);
  await release();
});

test('a reclaim that cannot clear the lock directory leaves the record it judged', async () => {
  const lockDirPath = path.join(tmpDir, 'immovable.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    ownerFilePath,
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  stampDirectoryAbandoned(lockDirPath);

  const realRemove = fs.rmSync;
  const removeSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike) => {
    if (String(target) !== lockDirPath) {
      return realRemove(target as string);
    }
    throw Object.assign(new Error('directory is busy'), { code: 'EBUSY' });
  }) as typeof fs.rmSync);

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

  // No record means no claim to attribute the directory to, and the age of the path is
  // evidence about the path alone. An empty directory is removed; this one is not.
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

function stampDirectoryAbandoned(directory: string): void {
  const abandoned = new Date(Date.now() - 60_000);
  fs.utimesSync(directory, abandoned, abandoned);
}

function currentProcessOwner(): ProcessLockOwner {
  return {
    pid: process.pid,
    startTime: readProcessStartTime(process.pid),
    acquiredAtMs: Date.now(),
  };
}
