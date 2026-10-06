import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stopDaemonProcess, waitForDaemonExit } from '../daemon-process.ts';

const DAEMON_COMMAND = '/opt/checkout/dist/src/internal/daemon.js';
const OURS = 'Mon Aug 24 10:00:00 2026';
const RECYCLED = 'Mon Aug 24 10:00:07 2026';
const PID = 4242;
const TIMEOUT_MS = 1_000;
const POLL_MS = 5;

const state = vi.hoisted(() => ({
  alive: new Map<number, boolean>(),
  starts: new Map<number, string>(),
  states: new Map<number, string>(),
  commands: new Map<number, string>(),
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: (pid: number) => state.alive.get(pid) ?? false,
  readProcessStartTime: (pid: number) => state.starts.get(pid) ?? null,
  readProcessCommand: (pid: number) => state.commands.get(pid) ?? null,
  readHostProcessIdentityObservations: (pids: Iterable<number>) => {
    const observations = new Map<number, { state: string; startTime: string }>();
    for (const pid of pids) {
      const startTime = state.starts.get(pid);
      if (startTime === undefined) continue;
      observations.set(pid, { state: state.states.get(pid) ?? 'S', startTime });
    }
    return observations;
  },
}));

const signals: NodeJS.Signals[] = [];
let onSignal: (signal: NodeJS.Signals) => void = () => {};

beforeEach(() => {
  state.alive.clear();
  state.starts.clear();
  state.states.clear();
  state.commands.clear();
  signals.length = 0;
  onSignal = () => {};
  state.alive.set(PID, true);
  state.starts.set(PID, OURS);
  state.states.set(PID, 'S');
  state.commands.set(PID, DAEMON_COMMAND);
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: NodeJS.Signals | 0) => {
    if (pid !== PID || signal === 0) return true;
    signals.push(signal);
    onSignal(signal);
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER])(
  'an invalid native pid %s cannot prove exit during recovery',
  async (pid) => {
    expect(await waitForDaemonExit({ pid, startTime: OURS }, { timeoutMs: 0 })).toEqual({
      exited: false,
      elapsedMs: 0,
    });
  },
);

test('waitForDaemonExit reports a pid recycled mid-wait as exited, without burning the deadline', async () => {
  setTimeout(() => state.starts.set(PID, RECYCLED), 20);
  const wait = await waitForDaemonExit(
    { pid: PID, startTime: OURS },
    { timeoutMs: TIMEOUT_MS, pollMs: POLL_MS },
  );
  expect(wait.exited).toBe(true);
  expect(wait.elapsedMs).toBeLessThan(TIMEOUT_MS / 2);
});

test('waitForDaemonExit reports a daemon that keeps its identity as not exited', async () => {
  const wait = await waitForDaemonExit(
    { pid: PID, startTime: OURS },
    { timeoutMs: 40, pollMs: POLL_MS },
  );
  expect(wait.exited).toBe(false);
});

test('a verified zombie proves exit before its pid is reaped', async () => {
  state.states.set(PID, 'Z+');
  state.commands.set(PID, '<defunct>');
  const stillTaken = await waitForDaemonExit(
    { pid: PID, startTime: OURS },
    { timeoutMs: 40, pollMs: POLL_MS },
  );
  expect(stillTaken.exited).toBe(true);
  expect(stillTaken.elapsedMs).toBeLessThan(40);
  expect(
    await stopDaemonProcess(
      { pid: PID, startTime: OURS },
      { mode: 'force', termTimeoutMs: 0, killTimeoutMs: 0 },
    ),
  ).toMatchObject({ status: 'exited', mode: 'already-exited' });
  expect(signals).toEqual([]);

  state.alive.set(PID, false);
  const reaped = await waitForDaemonExit(
    { pid: PID, startTime: OURS },
    { timeoutMs: TIMEOUT_MS, pollMs: POLL_MS },
  );
  expect(reaped.exited).toBe(true);
});

test('stopDaemonProcess does not SIGKILL a pid recycled during the grace wait', async () => {
  onSignal = (signal) => {
    if (signal === 'SIGTERM') state.starts.set(PID, RECYCLED);
  };
  await stopDaemonProcess(
    { pid: PID, startTime: OURS },
    { mode: 'graceful', termTimeoutMs: TIMEOUT_MS, killTimeoutMs: 40 },
  );
  expect(signals).toEqual(['SIGTERM']);
});

test('stopDaemonProcess still escalates to SIGKILL for a daemon that survives SIGTERM', async () => {
  onSignal = (signal) => {
    if (signal === 'SIGKILL') state.alive.set(PID, false);
  };
  await stopDaemonProcess(
    { pid: PID, startTime: OURS },
    { mode: 'graceful', termTimeoutMs: 40, killTimeoutMs: 40 },
  );
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});

test('a changed command in the same process lifetime does not prove exit', async () => {
  state.commands.set(PID, '/usr/bin/another-command');
  expect(await waitForDaemonExit({ pid: PID, startTime: OURS }, { timeoutMs: 0 })).toMatchObject({
    exited: false,
  });
});

test('an unreadable process start time does not prove exit', async () => {
  state.starts.delete(PID);
  expect(await waitForDaemonExit({ pid: PID, startTime: OURS }, { timeoutMs: 0 })).toMatchObject({
    exited: false,
  });
});

test('a recycled pid proves the original exit even when its successor is a zombie', async () => {
  state.starts.set(PID, RECYCLED);
  state.states.set(PID, 'Z');
  expect(await waitForDaemonExit({ pid: PID, startTime: OURS }, { timeoutMs: 0 })).toMatchObject({
    exited: true,
  });
});

test('missing start-time identity retains a live daemon without signaling', async () => {
  expect(
    await stopDaemonProcess(
      { pid: PID, startTime: null },
      { mode: 'graceful', termTimeoutMs: 0, killTimeoutMs: 0 },
    ),
  ).toMatchObject({ status: 'retained', reason: 'missing-start-time' });
  expect(signals).toEqual([]);
});

test('an unidentified released pid has no lifetime cleanup proof', async () => {
  state.alive.set(PID, false);
  expect(
    await stopDaemonProcess(
      { pid: PID, startTime: null },
      {
        mode: 'graceful',
        termTimeoutMs: 0,
        killTimeoutMs: 0,
      },
    ),
  ).toEqual({ status: 'not-running' });
  expect(signals).toEqual([]);
});

test('an exhausted kill wait returns retained rather than silently completing', async () => {
  expect(
    await stopDaemonProcess(
      { pid: PID, startTime: OURS },
      { mode: 'graceful', termTimeoutMs: 0, killTimeoutMs: 0 },
    ),
  ).toMatchObject({ status: 'retained', reason: 'exit-timeout' });
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});

test('failed signaling is retained when the same daemon is still alive', async () => {
  vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error('signal refused'), { code: 'EPERM' });
  });
  expect(
    await stopDaemonProcess(
      { pid: PID, startTime: OURS },
      { mode: 'graceful', termTimeoutMs: 0, killTimeoutMs: 0 },
    ),
  ).toMatchObject({ status: 'retained', reason: 'signal-failed', signal: 'SIGTERM' });
});

test('force termination delivers KILL first and returns its confirmed exit', async () => {
  onSignal = (signal) => {
    if (signal === 'SIGKILL') state.alive.set(PID, false);
  };
  const options = { mode: 'force' as const, termTimeoutMs: 0, killTimeoutMs: 0 };
  const result = await stopDaemonProcess({ pid: PID, startTime: OURS }, options);
  expect(signals).toEqual(['SIGKILL']);
  expect(result).toMatchObject({
    status: 'exited',
    identity: { pid: PID, startTime: OURS },
    mode: 'forced',
  });
});

test('a daemon that becomes a zombie on TERM retains graceful mode without SIGKILL', async () => {
  onSignal = (signal) => {
    if (signal !== 'SIGTERM') return;
    state.states.set(PID, 'Z');
    state.commands.set(PID, '<defunct>');
  };
  const result = await stopDaemonProcess(
    { pid: PID, startTime: OURS },
    { mode: 'graceful', termTimeoutMs: 0, killTimeoutMs: 0 },
  );
  expect(signals).toEqual(['SIGTERM']);
  expect(result).toMatchObject({ status: 'exited', mode: 'graceful' });
});
