import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

const { processToolRuns } = vi.hoisted(() => ({
  // `unanswered` makes the process tool answer nothing at once, as a host too loaded to say.
  processToolRuns: { sync: 0, async: 0, unanswered: false },
}));

vi.mock('./exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exec.ts')>();
  const isProcessTool = (cmd: string) => cmd.endsWith('/ps') || cmd === 'powershell.exe';
  return {
    ...actual,
    runCmd: (...args: Parameters<typeof actual.runCmd>) => {
      if (isProcessTool(args[0])) {
        processToolRuns.async += 1;
        if (processToolRuns.unanswered) {
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
        }
      }
      return actual.runCmd(...args);
    },
    runCmdSync: (...args: Parameters<typeof actual.runCmdSync>) => {
      if (isProcessTool(args[0])) processToolRuns.sync += 1;
      return actual.runCmdSync(...args);
    },
  };
});

import type * as ProcessLock from './process-lock.ts';
import { writeLockOwnerFixture } from './process-lock.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

let tmpDir: string;
let acquireProcessLock: typeof ProcessLock.acquireProcessLock;

// A fresh module per test starts with this process's own identity unread, as a new daemon does.
beforeEach(async () => {
  vi.resetModules();
  ({ acquireProcessLock } = await import('./process-lock.ts'));
  tmpDir = mkdtempForTestSync('agent-device-process-lock-wait-');
  processToolRuns.sync = 0;
  processToolRuns.async = 0;
  processToolRuns.unanswered = false;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A daemon waits on device-claim and registration locks on the event loop every other session
// shares. Polling a live owner every 100 ms must not block that loop on the host process tool, and
// must not spend one process-table read per poll either.
test('waiting behind a live owner reads its identity off the event loop, about once a second', async () => {
  const lockDirPath = path.join(tmpDir, 'contended.lock');
  writeLockOwnerFixture(lockDirPath, {
    pid: process.ppid,
    startTime: null,
    acquiredAtMs: Date.now(),
    claimToken: 'live-rival',
  });

  await assert.rejects(
    () =>
      acquireProcessLock({
        lockDirPath,
        owner: { pid: process.pid, startTime: null, acquiredAtMs: Date.now() },
        timeoutMs: 1_050,
      }),
    /Timed out/,
  );

  assert.equal(processToolRuns.sync, 0, 'a waiter blocked the event loop on the process tool');
  // Two runs for this process's own identity, then one owner read when the wait starts, one when
  // the reused observation expires, and one for the timeout report: never one per 100 ms poll.
  assert.ok(
    processToolRuns.async >= 1 && processToolRuns.async <= 5,
    `the waiter ran the process tool ${processToolRuns.async} times`,
  );
});

// The guard a waiter takes names its holder, and this process's own start time is not read yet in a
// fresh module: taking and giving back the lock must still never block on the process tool.
test('acquiring and releasing a free lock reads this process identity off the event loop', async () => {
  const release = await acquireProcessLock({
    lockDirPath: path.join(tmpDir, 'free.lock'),
    owner: { pid: process.pid, startTime: null, acquiredAtMs: Date.now() },
  });
  await release();

  assert.equal(processToolRuns.sync, 0, 'taking the guard blocked on the process tool');
  assert.ok(processToolRuns.async >= 1, 'this process identity was never read');
});

// A release waits up to five seconds for a guard. One that has stood for a minute under a live
// holder is probed, but its holder's identity is read about once a second, not on every 5 ms poll.
test('a release waiting on a long-standing live guard reads its holder about once a second', async () => {
  const lockDirPath = path.join(tmpDir, 'guarded.lock');
  const release = await acquireProcessLock({
    lockDirPath,
    owner: { pid: process.pid, startTime: null, acquiredAtMs: Date.now() },
  });
  const mutexPath = path.join(tmpDir, 'guarded.reclaim.lock');
  fs.writeFileSync(
    mutexPath,
    JSON.stringify({
      pid: process.ppid,
      startTime: null,
      token: '00000000-0000-4000-8000-000000000002',
    }),
  );
  const standing = new Date(Date.now() - 60_000);
  fs.utimesSync(mutexPath, standing, standing);
  processToolRuns.sync = 0;
  processToolRuns.async = 0;
  processToolRuns.unanswered = true;
  vi.useFakeTimers();
  let outcome: unknown;
  try {
    const releasing = release().then(
      () => 'released',
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(6_000);
    outcome = await releasing;
  } finally {
    vi.useRealTimers();
  }

  assert.match(String(outcome), /Cannot verify ownership/);
  assert.equal(processToolRuns.sync, 0);
  // Two runs for this process's own identity, then one holder read per second of the wait.
  assert.ok(
    processToolRuns.async >= 1 && processToolRuns.async <= 8,
    `the release ran the process tool ${processToolRuns.async} times`,
  );
});

test('an acquisition aborted before it starts is canceled without reading any process', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () =>
      acquireProcessLock({
        lockDirPath: path.join(tmpDir, 'aborted.lock'),
        owner: { pid: process.pid, startTime: null, acquiredAtMs: Date.now() },
        signal: controller.signal,
      }),
    (error: unknown) =>
      (error as { details?: { reason?: string } }).details?.reason === 'request_canceled',
  );
  assert.equal(processToolRuns.async + processToolRuns.sync, 0);
  assert.equal(fs.existsSync(path.join(tmpDir, 'aborted.lock')), false);
});
