import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { isProcessAlive, readProcessStartTime } from '../../utils/host-process.ts';
import { isAgentDeviceDaemonProcess, stopProcessForTakeover } from '../daemon-process.ts';

const TAKEOVER_TIMEOUTS = { termTimeoutMs: 5_000, killTimeoutMs: 2_000 };
const spawnedPids: number[] = [];
const spawnedRoots: string[] = [];

afterEach(() => {
  for (const pid of spawnedPids.splice(0)) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The test's assertion already observed that the child exited.
    }
  }
  for (const root of spawnedRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A daemon entry from a branch-named checkout, whose path has no project-name marker. */
function spawnFakeDaemonFromBranchNamedCheckout(): { pid: number; entryPath: string } {
  // Vitest redirects `os.tmpdir()` under a worktree-named run directory. Use
  // the host temp root so this path itself cannot accidentally contain the
  // project name and mask the worktree identity regression.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, 'repair-evidence-')));
  spawnedRoots.push(root);
  const entryPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, 'setInterval(() => {}, 1000);\n', 'utf8');
  const child = spawn(process.execPath, [entryPath], { stdio: 'ignore' });
  const pid = child.pid ?? 0;
  assert.ok(pid > 0, 'expected the fake daemon to have a pid');
  spawnedPids.push(pid);
  return { pid, entryPath };
}

// #1545: a reachable daemon with a code-signature mismatch is replaced. If a
// branch-named worktree is rejected as "not ours", replacement leaves the old
// daemon alive and the next request reaches a fresh empty session store.
test('stops a branch-named daemon before replacement can strand its session', async () => {
  const { pid, entryPath } = spawnFakeDaemonFromBranchNamedCheckout();
  assert.equal(entryPath.toLowerCase().includes('agent-device'), false);

  const startTime = readProcessStartTime(pid);
  assert.ok(startTime, 'expected the spawned daemon to report a start time');
  assert.equal(isAgentDeviceDaemonProcess(pid, startTime), true);

  await stopProcessForTakeover(pid, { ...TAKEOVER_TIMEOUTS, expectedStartTime: startTime });
  assert.equal(isProcessAlive(pid), false);
});

test('does not stop a branch-named daemon when process identity is missing', async () => {
  const { pid, entryPath } = spawnFakeDaemonFromBranchNamedCheckout();
  assert.equal(entryPath.toLowerCase().includes('agent-device'), false);

  assert.equal(isAgentDeviceDaemonProcess(pid, undefined), false);

  await stopProcessForTakeover(pid, { ...TAKEOVER_TIMEOUTS, expectedStartTime: undefined });
  assert.equal(isProcessAlive(pid), true);
});

test('does not stop a branch-named daemon when the pid belongs to a different process lifetime', async () => {
  const { pid, entryPath } = spawnFakeDaemonFromBranchNamedCheckout();
  assert.equal(entryPath.toLowerCase().includes('agent-device'), false);

  const actualStartTime = readProcessStartTime(pid);
  assert.ok(actualStartTime, 'expected the spawned daemon to report a start time');
  const staleStartTime = `${actualStartTime}-previous-lifetime`;
  assert.equal(isAgentDeviceDaemonProcess(pid, staleStartTime), false);

  await stopProcessForTakeover(pid, {
    ...TAKEOVER_TIMEOUTS,
    expectedStartTime: staleStartTime,
  });
  assert.equal(isProcessAlive(pid), true);
});
