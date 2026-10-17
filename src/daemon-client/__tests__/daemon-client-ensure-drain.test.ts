import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { closeLoopbackServer, supportsLoopbackBind } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { finishRegisteredDaemonFixtures } from '../../__tests__/test-utils/registered-daemon-fixture.ts';
import {
  draining,
  launchesFreshDaemonAt,
  okResult,
  registerDaemon,
  startScriptedDaemon,
  stateDirAndPaths,
} from './explicit-lifecycle-fixture.ts';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/command')>()),
  runCmdDetachedMonitored: vi.fn(),
}));
// An embedded host registered by some other process runs a command that is no daemon entry.
let hostedByAnotherProcess = false;
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    readProcessCommand: (pid: number) =>
      hostedByAnotherProcess ? 'node /opt/app/server.js' : actual.readProcessCommand(pid),
  };
});
vi.mock('@agent-device/host-kit/retry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/retry')>()),
  sleep: vi.fn(),
}));
import { runCmdDetachedMonitored } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { ensureDaemon } from '../daemon-client-ensure.ts';

// A daemon that accepted a quiesce request is leaving by itself. These tests give the drain a
// virtual clock that starts when the daemon says `draining`, so a drain of any length costs no real
// time, and watch which signals the client sends while it waits.

const spawn = vi.mocked(runCmdDetachedMonitored);
const actualRetry = await vi.importActual<typeof import('@agent-device/host-kit/retry')>(
  '@agent-device/host-kit/retry',
);
const realNow = Date.now.bind(Date);
const actualKill = process.kill.bind(process);

// What the old retirement waited before it escalated to SIGKILL; a healthy drain may outlast it.
const OLD_GRACE_MS = 3_000;
// `DRAIN_DEADLINE_MS` in `daemon-client-ensure.ts`.
const DRAIN_DEADLINE_MS = 60_000;

afterEach(async () => {
  hostedByAnotherProcess = false;
  vi.restoreAllMocks();
  spawn.mockReset();
  vi.mocked(sleep).mockReset();
  await finishRegisteredDaemonFixtures();
});

type VirtualDrain = {
  /** Virtual milliseconds since the daemon answered `draining`. */
  elapsedMs: () => number;
  /** Starts the clock; called by the stand-in daemon as it answers. */
  begin: (leavesAfterMs: number | undefined) => void;
  /** Ends the virtual phase and returns to the real clock. */
  end: () => void;
  signals: Array<{ signal: NodeJS.Signals | number; atMs: number }>;
};

/**
 * Time only moves while the client waits for the drain, and signals to \`pid\` are recorded with the
 * virtual time they arrived at. \`leavesAfterMs\` is when the daemon finishes leaving by itself.
 */
function installVirtualDrain(pid: () => number): VirtualDrain {
  let virtual = false;
  let now = 0;
  let startedAt = 0;
  let leavesAt: number | undefined;
  const signals: VirtualDrain['signals'] = [];
  vi.spyOn(Date, 'now').mockImplementation(() => (virtual ? now : realNow()));
  vi.mocked(sleep).mockImplementation(async (ms: number) => {
    if (!virtual) return await actualRetry.sleep(ms);
    now += ms;
    if (leavesAt !== undefined && now >= leavesAt) {
      leavesAt = undefined;
      actualKill(pid(), 'SIGTERM');
      await waitForExit(pid());
      virtual = false;
    }
  });
  vi.spyOn(process, 'kill').mockImplementation(((
    target: number,
    signal?: NodeJS.Signals | number,
  ) => {
    if (target === pid() && signal !== undefined && signal !== 0) {
      signals.push({ signal, atMs: now - startedAt });
      virtual = false;
    }
    return actualKill(target, signal ?? 'SIGTERM');
  }) as typeof process.kill);
  return {
    elapsedMs: () => now - startedAt,
    begin: (leavesAfterMs) => {
      now = realNow();
      startedAt = now;
      leavesAt = leavesAfterMs === undefined ? undefined : now + leavesAfterMs;
      virtual = true;
    },
    end: () => {
      virtual = false;
    },
    signals,
  };
}

async function waitForExit(pid: number): Promise<void> {
  for (let polls = 0; isProcessAlive(pid) && polls < 500; polls += 1) {
    await actualRetry.sleep(10);
  }
}

async function withLoopback(t: { skip: (note: string) => void }): Promise<boolean> {
  if (await supportsLoopbackBind()) return true;
  t.skip('loopback listeners are not permitted in this environment');
  return false;
}

test('a drain that outlasts the old kill window is waited out, not signaled', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  let childPid = 0;
  const drain = installVirtualDrain(() => childPid);
  const stale = await startScriptedDaemon(draining, { afterRpc: () => drain.begin(5_000) });
  const fresh = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  childPid = child.pid;
  launchesFreshDaemonAt(spawn, paths, fresh.port);

  try {
    const connection = await ensureDaemon({ stateDir, daemonTransport: 'http' });

    assert.equal(connection.started, true);
    assert.ok(drain.elapsedMs() >= 5_000, 'the drain ran for 5 virtual seconds');
    assert.ok(drain.elapsedMs() > OLD_GRACE_MS);
    assert.deepEqual(drain.signals, [], 'the client signaled nothing while the daemon drained');
    assert.equal(isProcessAlive(childPid), false, 'the daemon left by itself');
    assert.equal(spawn.mock.calls.length, 1, 'its successor started after it left');
  } finally {
    await closeLoopbackServer(stale.server);
    await closeLoopbackServer(fresh.server);
  }
});

test('a daemon still running past the deadline that answers no probe is force-retired', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  let childPid = 0;
  const drain = installVirtualDrain(() => childPid);
  // A draining daemon has closed its servers, so it answers no liveness probe.
  const stale = await startScriptedDaemon(draining, {
    afterRpc: () => {
      drain.begin(undefined);
      void closeLoopbackServer(stale.server);
    },
  });
  const fresh = await startScriptedDaemon(okResult({}));
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  childPid = child.pid;
  launchesFreshDaemonAt(spawn, paths, fresh.port);

  try {
    const connection = await ensureDaemon({ stateDir, daemonTransport: 'http' });

    assert.equal(connection.started, true);
    assert.equal(drain.signals.length > 0, true, 'the stuck daemon was signaled');
    assert.ok(
      drain.signals.every(({ atMs }) => atMs >= DRAIN_DEADLINE_MS),
      `no signal before the deadline: ${JSON.stringify(drain.signals)}`,
    );
    assert.equal(isProcessAlive(childPid), false);
    assert.equal(spawn.mock.calls.length, 1);
  } finally {
    await closeLoopbackServer(fresh.server);
  }
});

test('a daemon still running past the deadline that answers a probe is left alone', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  let childPid = 0;
  const drain = installVirtualDrain(() => childPid);
  const stale = await startScriptedDaemon(draining, { afterRpc: () => drain.begin(undefined) });
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  childPid = child.pid;

  try {
    await assert.rejects(ensureDaemon({ stateDir, daemonTransport: 'http' }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, 'daemon-drain-timeout');
      assert.match(String(error.details?.hint), /agent-device daemon stop/);
      return true;
    });
    assert.deepEqual(drain.signals, []);
    assert.equal(isProcessAlive(childPid), true);
    assert.equal(spawn.mock.calls.length, 0);
    drain.end();
  } finally {
    await closeLoopbackServer(stale.server);
  }
});

test('an embedded host that outlives the deadline and answers no probe is never signaled', async (t) => {
  if (!(await withLoopback(t))) return;
  const { stateDir, paths } = stateDirAndPaths();
  let childPid = 0;
  const drain = installVirtualDrain(() => childPid);
  const stale = await startScriptedDaemon(draining, {
    afterRpc: () => {
      drain.begin(undefined);
      void closeLoopbackServer(stale.server);
    },
  });
  const { child } = await registerDaemon(paths, {
    httpPort: stale.port,
    version: '0.0.0-stale',
    capabilities: ['quiesce'],
  });
  childPid = child.pid;
  hostedByAnotherProcess = true;

  await assert.rejects(ensureDaemon({ stateDir, daemonTransport: 'http' }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.details?.reason, 'daemon-drain-timeout');
    return true;
  });

  assert.deepEqual(drain.signals, []);
  assert.equal(isProcessAlive(childPid), true);
  assert.equal(spawn.mock.calls.length, 0);
  drain.end();
});
