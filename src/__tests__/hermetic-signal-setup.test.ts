import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { afterEach, test } from 'vitest';
import { drainRefusedWritesForTest } from './hermetic-signal-setup.ts';

// The guard in hermetic-signal-setup.ts is what keeps a unit test from reaching
// a process it does not own (#1824). These drive its refusal paths deliberately,
// so each one drains the record the guard would otherwise fail the test with.

const execFileAsync = promisify(execFile);

afterEach(() => {
  assert.deepEqual(drainRefusedWritesForTest(), [], 'a test left an unasserted refusal behind');
});

function spawnSleeper() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: 'ignore' });
}

test('a live direct child may be signalled, and its process group with it', async () => {
  const child = spawnSleeper();
  const pid = child.pid;
  assert.ok(pid);

  process.kill(pid, 'SIGTERM');
  await once(child, 'exit');

  assert.deepEqual(drainRefusedWritesForTest(), []);
});

test('authority ends when a child is reaped, so its recycled pid is refused', async () => {
  const child = spawnSleeper();
  const pid = child.pid;
  assert.ok(pid);
  child.kill('SIGKILL');
  await once(child, 'exit');

  // The pid is now free for the kernel to hand to an unrelated process, so the
  // worker no longer owns it — even though this worker did spawn it once.
  assert.throws(
    () => process.kill(pid, 'SIGTERM'),
    (error: NodeJS.ErrnoException) =>
      error.code === 'ESRCH' && /did not spawn it/.test(error.message),
  );

  const [record] = drainRefusedWritesForTest();
  assert.match(record ?? '', new RegExp(`SIGTERM -> pid ${pid}`));
});

test('a live process this worker never spawned is refused', () => {
  // The vitest main process: alive, not ours.
  assert.throws(
    () => process.kill(process.ppid, 'SIGTERM'),
    (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
  );
  assert.equal(drainRefusedWritesForTest().length, 1);
});

test('a liveness probe stays free', () => {
  assert.equal(process.kill(process.ppid, 0), true);
  assert.deepEqual(drainRefusedWritesForTest(), []);
});

test('a promisified execFile cannot smuggle a pkill past the guard', async () => {
  // promisify() resolves through the custom-promisify symbol rather than calling
  // the wrapper, so this path needs its own interception.
  await assert.rejects(
    execFileAsync('pkill', ['-f', 'xcodebuild.*AgentDeviceRunner']),
    (error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' && /Refusing to spawn/.test(error.message),
  );

  const [record] = drainRefusedWritesForTest();
  assert.match(record ?? '', /spawn pkill -f xcodebuild/);
});

test('a promisified execFile still tracks the child it starts', async () => {
  const pending = execFileAsync(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)']);
  const pid = pending.child.pid;
  assert.ok(pid);

  process.kill(pid, 'SIGKILL');
  await pending.catch(() => {});

  assert.deepEqual(drainRefusedWritesForTest(), []);
});

test('a spawned kill binary is refused whichever entry point starts it', () => {
  assert.throws(() => spawn('pkill', ['-TERM', '-P', '4242']), /Refusing to spawn/);
  assert.throws(() => execFile('/usr/bin/killall', ['node']), /Refusing to spawn/);
  assert.equal(drainRefusedWritesForTest().length, 2);
});
