import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { stopProcessForTakeover, waitForDaemonExit } from '../daemon-process.ts';

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

vi.mock('../../utils/host-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/host-process.ts')>()),
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

test('waitForDaemonExit keeps waiting through a zombie until the pid is reaped', async () => {
  state.states.set(PID, 'Z+');
  state.commands.set(PID, '<defunct>');
  const stillTaken = await waitForDaemonExit(
    { pid: PID, startTime: OURS },
    { timeoutMs: 40, pollMs: POLL_MS },
  );
  expect(stillTaken.exited).toBe(false);

  state.alive.set(PID, false);
  const reaped = await waitForDaemonExit(
    { pid: PID, startTime: OURS },
    { timeoutMs: TIMEOUT_MS, pollMs: POLL_MS },
  );
  expect(reaped.exited).toBe(true);
});

test('stopProcessForTakeover does not SIGKILL a pid recycled during the grace wait', async () => {
  onSignal = (signal) => {
    if (signal === 'SIGTERM') state.starts.set(PID, RECYCLED);
  };
  await stopProcessForTakeover(PID, {
    termTimeoutMs: TIMEOUT_MS,
    killTimeoutMs: 40,
    expectedStartTime: OURS,
  });
  expect(signals).toEqual(['SIGTERM']);
});

test('stopProcessForTakeover still escalates to SIGKILL for a daemon that survives SIGTERM', async () => {
  onSignal = (signal) => {
    if (signal === 'SIGKILL') state.alive.set(PID, false);
  };
  await stopProcessForTakeover(PID, {
    termTimeoutMs: 40,
    killTimeoutMs: 40,
    expectedStartTime: OURS,
  });
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
});
