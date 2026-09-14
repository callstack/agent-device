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

const RECLAIMED_MARK = '.reclaimed-';

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

test('acquireProcessLock does not evict a live owner whose owner.json is malformed', async () => {
  const lockDirPath = path.join(tmpDir, 'malformed.lock');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(path.join(lockDirPath, 'owner.json'), '{ pid: ');
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

test('one abandoned lock offered to two contenders is held by exactly one of them', async () => {
  const lockDirPath = path.join(tmpDir, 'contended.lock');
  fs.mkdirSync(lockDirPath);
  stampDirectoryAbandoned(lockDirPath);

  const attempts = await Promise.allSettled([
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      ownerGraceMs: 0,
      timeoutMs: 250,
      pollMs: 2,
    }),
    acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      ownerGraceMs: 0,
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
  assert.deepEqual(listReclaimedSiblings(tmpDir), []);
});

function listReclaimedSiblings(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.includes(RECLAIMED_MARK))
    .sort();
}

const UNINFORMATIVE_OWNER_RECORDS = [
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

test('a forced reclaim leaves a directory that a live owner republished', async () => {
  const lockDirPath = path.join(tmpDir, 'republished.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    ownerFilePath,
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );

  // A win32 handle refuses the rename, and by the time the forced removal would run a
  // live holder has claimed the path: the forced removal must not reach its directory.
  const realRename = fs.renameSync;
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
    from: fs.PathLike,
    to: fs.PathLike,
  ) => {
    if (!String(to).includes(RECLAIMED_MARK)) return realRename(from, to);
    fs.rmSync(String(from), { recursive: true, force: true });
    fs.mkdirSync(String(from));
    fs.writeFileSync(path.join(String(from), 'owner.json'), JSON.stringify(currentProcessOwner()));
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  }) as typeof fs.renameSync);

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
    assert.equal(fs.existsSync(ownerFilePath), true);
  } finally {
    renameSpy.mockRestore();
  }
});

test('a reclaim that cannot remove the directory it moved aside still holds the lock', async () => {
  const lockDirPath = path.join(tmpDir, 'immovable.lock');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    path.join(lockDirPath, 'owner.json'),
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  stampDirectoryAbandoned(lockDirPath);

  const realRemove = fs.rmSync;
  const removeSpy = vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options) => {
    if (String(target).includes(RECLAIMED_MARK)) {
      throw Object.assign(new Error('directory is busy'), { code: 'EBUSY' });
    }
    return realRemove(target, options);
  }) as typeof fs.rmSync);

  try {
    const release = await acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 500,
      pollMs: 1,
    });
    assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
    await release();
  } finally {
    removeSpy.mockRestore();
  }
});

test('a live owner published between the stale read and the rename keeps its lock', async () => {
  const lockDirPath = path.join(tmpDir, 'stolen-race.lock');
  const ownerFilePath = path.join(lockDirPath, 'owner.json');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    ownerFilePath,
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  stampDirectoryAbandoned(lockDirPath);

  // The dead record is read, and before the rename lands another contender reclaims the
  // path, publishes itself, and goes live. The rename then moves that live directory, and
  // the only thing that can tell it apart from the one judged abandoned is the directory
  // itself.
  let republished = false;
  const realRename = fs.renameSync;
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
    from: fs.PathLike,
    to: fs.PathLike,
  ) => {
    if (!String(to).includes(RECLAIMED_MARK) || republished) return realRename(from, to);
    republished = true;
    fs.rmSync(String(from), { recursive: true, force: true });
    fs.mkdirSync(String(from));
    fs.writeFileSync(path.join(String(from), 'owner.json'), JSON.stringify(currentProcessOwner()));
    return realRename(from, to);
  }) as typeof fs.renameSync);

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
        assert.equal(error.details?.ownerPid, process.pid);
        return true;
      },
    );
    assert.equal(republished, true);
    assert.equal(
      (JSON.parse(fs.readFileSync(ownerFilePath, 'utf8')) as { pid: number }).pid,
      process.pid,
    );
    assert.deepEqual(
      fs
        .readdirSync(tmpDir)
        .filter((name) => name.includes(RECLAIMED_MARK))
        .sort(),
      [],
    );
  } finally {
    renameSpy.mockRestore();
  }
});

test('a reclaim whose directory another contender moved aside retries and acquires', async () => {
  const lockDirPath = path.join(tmpDir, 'lost-race.lock');
  fs.mkdirSync(lockDirPath);
  fs.writeFileSync(
    path.join(lockDirPath, 'owner.json'),
    JSON.stringify({ pid: 999_999_999, startTime: null, acquiredAtMs: Date.now() }),
  );
  stampDirectoryAbandoned(lockDirPath);

  // The contender that loses the rename finds the path already gone and cannot have
  // cleared anything; it goes back to `mkdir`, which is what decides the lock.
  let attempted = 0;
  const realRename = fs.renameSync;
  const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((
    from: fs.PathLike,
    to: fs.PathLike,
  ) => {
    if (!String(to).includes(RECLAIMED_MARK)) return realRename(from, to);
    attempted += 1;
    fs.rmSync(lockDirPath, { recursive: true, force: true });
    throw Object.assign(new Error('no such directory'), { code: 'ENOENT' });
  }) as typeof fs.renameSync);

  try {
    const release = await acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 500,
      pollMs: 1,
    });
    assert.equal(attempted, 1);
    assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
    await release();
  } finally {
    renameSpy.mockRestore();
  }
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
