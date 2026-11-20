import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
// oxlint-disable-next-line no-restricted-imports -- real /tmp socket path within the 104-char limit
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import {
  isProcessAlive,
  readProcessCommand,
  readProcessStartTime,
} from '@agent-device/host-kit/process';
import { staleBirthTokenLike } from '@agent-device/test-kit';
import { isAgentDeviceDaemonProcess, stopDaemonProcess } from './daemon-process.ts';

const TAKEOVER_TIMEOUTS = { termTimeoutMs: 5_000, killTimeoutMs: 2_000 };
const spawnedChildren: { child: ChildProcess; exited: Promise<void> }[] = [];
const spawnedRoots: string[] = [];

test.each([0, -1, 1.5, Number.NaN, '123', 2_147_483_648, Number.MAX_SAFE_INTEGER])(
  'an invalid daemon pid %s cannot prove exit',
  async (pid) => {
    assert.deepEqual(
      await stopDaemonProcess(
        { pid: pid as number, startTime: 'captured-birth' },
        { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 0 },
      ),
      { status: 'retained', reason: 'identity-unverified' },
    );
  },
);

afterEach(async () => {
  for (const { child, exited } of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
  for (const root of spawnedRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A daemon entry from a checkout under `prefix`, whose path has no project-name marker. */
function spawnFakeDaemon(prefix: string): { pid: number; entryPath: string } {
  // Vitest redirects `os.tmpdir()` under a worktree-named run directory. Use
  // the host temp root so this path itself cannot accidentally contain the
  // project name and mask the worktree identity regression.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tempRoot, prefix)));
  spawnedRoots.push(root);
  const entryPath = path.join(root, 'dist', 'src', 'internal', 'daemon.js');
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, 'setInterval(() => {}, 1000);\n', 'utf8');
  const child = spawn(process.execPath, [entryPath], { stdio: 'ignore' });
  const pid = child.pid ?? 0;
  assert.ok(pid > 0, 'expected the fake daemon to have a pid');
  spawnedChildren.push({
    child,
    exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
  });
  return { pid, entryPath };
}

/** A daemon entry from a branch-named checkout, whose path has no project-name marker. */
function spawnFakeDaemonFromBranchNamedCheckout(): { pid: number; entryPath: string } {
  return spawnFakeDaemon('repair-evidence-');
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

  const result = await stopDaemonProcess(
    { pid, startTime },
    { mode: 'graceful', ...TAKEOVER_TIMEOUTS },
  );
  assert.equal(result.status, 'exited');
  await spawnedChildren.at(-1)!.exited;
  assert.equal(isProcessAlive(pid), false);
});

test('does not stop a branch-named daemon when process identity is missing', async () => {
  const { pid, entryPath } = spawnFakeDaemonFromBranchNamedCheckout();
  assert.equal(entryPath.toLowerCase().includes('agent-device'), false);

  assert.equal(isAgentDeviceDaemonProcess(pid, undefined), false);

  const result = await stopDaemonProcess(
    { pid, startTime: null },
    { mode: 'graceful', ...TAKEOVER_TIMEOUTS },
  );
  assert.deepEqual(result, { status: 'retained', reason: 'missing-start-time' });
  assert.equal(isProcessAlive(pid), true);
});

test('does not stop a branch-named daemon when the pid belongs to a different process lifetime', async () => {
  const { pid, entryPath } = spawnFakeDaemonFromBranchNamedCheckout();
  assert.equal(entryPath.toLowerCase().includes('agent-device'), false);

  const actualStartTime = readProcessStartTime(pid);
  assert.ok(actualStartTime, 'expected the spawned daemon to report a start time');
  // A proven reuse needs a stale value in the same verified format as the live read; a legacy
  // token would be unverified rather than proof.
  const staleStartTime = staleBirthTokenLike(actualStartTime);
  assert.equal(isAgentDeviceDaemonProcess(pid, staleStartTime), false);

  const result = await stopDaemonProcess(
    { pid, startTime: staleStartTime },
    { mode: 'graceful', ...TAKEOVER_TIMEOUTS },
  );
  assert.deepEqual(result, {
    status: 'exited',
    mode: 'already-exited',
    identity: { pid, startTime: staleStartTime },
  });
  assert.equal(isProcessAlive(pid), true);
});

// #4656: a record written before the provenance pin holds a raw `lstart` rendering — fr_FR prints
// `mar. 17 nov. 19:42:27 2026`, locales that omit HH:mm:ss print no clock, and an earlier pinned
// build stored the raw C form. All are unqualified, so at the daemon stop boundary they yield
// unverified identity — never `already-exited`, and never a signal — so a live daemon is not
// retired while it still runs.
test.skipIf(process.platform !== 'darwin')(
  'a legacy raw record yields unverified identity at daemon stop, not an exited daemon',
  async () => {
    const { pid } = spawnFakeDaemonFromBranchNamedCheckout();
    const startTime = readProcessStartTime(pid);
    assert.ok(startTime, 'expected the spawned daemon to report a start time');
    assert.ok(startTime.startsWith('posix:'), `expected a posix birth token, got ${startTime}`);

    for (const legacy of [
      'mar. 17 nov. 19:42:27 2026',
      '17 nov. 2026',
      'Tue Nov 17 19:42:27 2026',
    ]) {
      const result = await stopDaemonProcess(
        { pid, startTime: legacy },
        { mode: 'graceful', termTimeoutMs: 200, killTimeoutMs: 100 },
      );
      assert.equal(result.status, 'retained', `legacy record ${legacy} must not retire the daemon`);
      if (result.status === 'retained') {
        assert.equal(result.reason, 'identity-unverified');
      }
      assert.equal(
        isProcessAlive(pid),
        true,
        'no signal may reach a daemon the legacy record cannot verify',
      );
    }
  },
);

test.skipIf(process.platform === 'win32')(
  'the stop route reads a non-ASCII daemon argv as UTF-8, not as C-locale escapes',
  async () => {
    const { pid, entryPath } = spawnFakeDaemon('utf8-é-ü-');
    assert.ok(entryPath.includes('é-ü'));

    const command = readProcessCommand(pid);
    assert.ok(command?.includes('é-ü'), `expected the UTF-8 argv, got ${JSON.stringify(command)}`);
    const startTime = readProcessStartTime(pid);
    assert.ok(startTime, 'expected the spawned daemon to report a start time');
    assert.equal(isAgentDeviceDaemonProcess(pid, startTime), true);

    const result = await stopDaemonProcess(
      { pid, startTime },
      { mode: 'graceful', ...TAKEOVER_TIMEOUTS },
    );
    assert.equal(result.status, 'exited');
    await spawnedChildren.at(-1)!.exited;
    assert.equal(isProcessAlive(pid), false);
  },
);
