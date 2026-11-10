import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';

const { processToolRuns } = vi.hoisted(() => ({
  processToolRuns: { sync: 0, async: 0 },
}));

vi.mock('./exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./exec.ts')>();
  const isProcessTool = (cmd: string) => cmd.endsWith('/ps') || cmd === 'powershell.exe';
  return {
    ...actual,
    runCmd: (...args: Parameters<typeof actual.runCmd>) => {
      if (isProcessTool(args[0])) processToolRuns.async += 1;
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
