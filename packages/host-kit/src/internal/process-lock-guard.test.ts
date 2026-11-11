import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import * as diagnostics from './diagnostics.ts';
import { acquireProcessLock, tryAcquireProcessLock } from './process-lock.ts';
import {
  currentProcessOwner,
  listReclaimSiblings,
  stampDirectoryAbandoned,
} from './process-lock.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempForTestSync('agent-device-process-lock-guard-');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A guard records its holder, so a holder that died inside its guarded step does not leave every
// later contender busy until a person removes the file.
const DEAD_GUARD_HOLDER = {
  pid: 999_999_999,
  startTime: null,
  token: '00000000-0000-4000-8000-000000000001',
};

test('a guard whose recorded holder is dead is reclaimed and the lock acquired', async () => {
  const lockDirPath = path.join(tmpDir, 'orphaned-guard.lock');
  const mutexPath = path.join(tmpDir, 'orphaned-guard.reclaim.lock');
  fs.writeFileSync(mutexPath, JSON.stringify(DEAD_GUARD_HOLDER));
  const diagnosticSpy = vi.spyOn(diagnostics, 'emitDiagnostic');
  try {
    const release = await acquireProcessLock({
      lockDirPath,
      owner: currentProcessOwner(),
      timeoutMs: 200,
      pollMs: 1,
    });
    assert.equal(fs.existsSync(path.join(lockDirPath, 'owner.json')), true);
    assert.deepEqual(
      diagnosticSpy.mock.calls
        .map(([event]) => event)
        .filter((event) => event.phase === 'process_lock_guard_reclaimed')
        .map((event) => event.data?.holderPid),
      [DEAD_GUARD_HOLDER.pid],
    );
    await release();
  } finally {
    diagnosticSpy.mockRestore();
  }
  assert.deepEqual(listReclaimSiblings(tmpDir), []);
});

test('a synchronous attempt reclaims a dead holder guard too', async () => {
  const lockDirPath = path.join(tmpDir, 'orphaned-guard-sync.lock');
  fs.writeFileSync(
    path.join(tmpDir, 'orphaned-guard-sync.reclaim.lock'),
    JSON.stringify(DEAD_GUARD_HOLDER),
  );
  const attempt = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  assert.equal(attempt.status, 'acquired');
  if (attempt.status === 'acquired') await attempt.acquisition.release();
  assert.deepEqual(listReclaimSiblings(tmpDir), []);
});

test('a long-standing guard whose holder pid now has another start time is reclaimed', async () => {
  const lockDirPath = path.join(tmpDir, 'reused-guard.lock');
  const mutexPath = path.join(tmpDir, 'reused-guard.reclaim.lock');
  const reusedHolder = {
    ...DEAD_GUARD_HOLDER,
    pid: process.ppid,
    startTime: 'Thu Jan  1 00:00:00 1970',
  };
  fs.writeFileSync(mutexPath, JSON.stringify(reusedHolder));
  stampDirectoryAbandoned(mutexPath);
  const release = await acquireProcessLock({
    lockDirPath,
    owner: currentProcessOwner(),
    timeoutMs: 2_000,
    pollMs: 1,
  });
  await release();
  assert.deepEqual(listReclaimSiblings(tmpDir), []);
});

test('a guard held by a live process, or naming no holder, is never reclaimed', async () => {
  const live = { ...DEAD_GUARD_HOLDER, pid: process.ppid, startTime: null };
  for (const [name, contents] of [
    ['live-holder', JSON.stringify(live)],
    ['unattributed', ''],
    ['bad-token', JSON.stringify({ ...DEAD_GUARD_HOLDER, token: '../escape' })],
  ] as const) {
    const lockDirPath = path.join(tmpDir, `${name}.lock`);
    const mutexPath = path.join(tmpDir, `${name}.reclaim.lock`);
    fs.writeFileSync(mutexPath, contents);
    stampDirectoryAbandoned(mutexPath);
    await assert.rejects(
      () =>
        acquireProcessLock({ lockDirPath, owner: currentProcessOwner(), timeoutMs: 30, pollMs: 1 }),
      /Timed out/,
    );
    assert.equal(fs.readFileSync(mutexPath, 'utf8'), contents, name);
  }
});

test('only one contender may reap a dead holder guard', async () => {
  const lockDirPath = path.join(tmpDir, 'reaped-by-another.lock');
  const mutexPath = path.join(tmpDir, 'reaped-by-another.reclaim.lock');
  fs.writeFileSync(mutexPath, JSON.stringify(DEAD_GUARD_HOLDER));
  // Another contender already holds the reap marker for this holder's token.
  fs.writeFileSync(`${mutexPath}.${DEAD_GUARD_HOLDER.token}.reap`, '');

  await assert.rejects(
    () =>
      acquireProcessLock({ lockDirPath, owner: currentProcessOwner(), timeoutMs: 30, pollMs: 1 }),
    /Timed out/,
  );
  assert.equal(fs.readFileSync(mutexPath, 'utf8'), JSON.stringify(DEAD_GUARD_HOLDER));
});

test('a guard this process takes names its holder', async () => {
  const lockDirPath = path.join(tmpDir, 'named-guard.lock');
  const written: string[] = [];
  const realWrite = fs.writeSync;
  const writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(((
    descriptor: number,
    data: string,
  ) => {
    written.push(data);
    return realWrite(descriptor, data);
  }) as typeof fs.writeSync);
  let attempt: ReturnType<typeof tryAcquireProcessLock>;
  try {
    attempt = tryAcquireProcessLock({ lockDirPath, owner: currentProcessOwner() });
  } finally {
    writeSpy.mockRestore();
  }
  assert.equal(attempt.status, 'acquired');
  if (attempt.status === 'acquired') await attempt.acquisition.release();
  const holder = JSON.parse(written[0]!) as { pid: number; token: string };
  assert.equal(holder.pid, process.pid);
  assert.match(holder.token, /^[0-9a-f-]{36}$/);
});
