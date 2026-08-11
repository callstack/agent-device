import { beforeEach, expect, test, vi } from 'vitest';
import {
  inspectManagedProcess,
  terminateManagedProcessSet,
} from './platform-runtime-screen-recording-process-host.ts';

const state = vi.hoisted(() => ({
  alive: new Map<number, boolean>(),
  starts: new Map<number, string>(),
  commands: new Map<number, string>(),
  signaled: [] as Array<{ pids: readonly number[]; signal: NodeJS.Signals }>,
}));

vi.mock('./utils/host-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils/host-process.ts')>()),
  isProcessAlive: (pid: number) => state.alive.get(pid) ?? false,
  isProcessZombie: () => false,
  readProcessStartTime: (pid: number) => state.starts.get(pid) ?? null,
  readProcessCommand: (pid: number) => state.commands.get(pid) ?? null,
  listHostProcesses: async () => [
    { pid: 41, command: 'wrapper' },
    { pid: 42, ppid: 41, command: 'recorder child' },
  ],
  signalPidsBestEffort: (pids: readonly number[], signal: NodeJS.Signals) => {
    state.signaled.push({ pids, signal });
    for (const pid of pids) state.alive.set(pid, false);
    return pids.length;
  },
  waitForProcessExit: async (pid: number) => !(state.alive.get(pid) ?? false),
}));

beforeEach(() => {
  state.alive.clear();
  state.starts.clear();
  state.commands.clear();
  state.signaled.length = 0;
});

test('rejects PID reuse when start time or full command changes', () => {
  state.alive.set(41, true);
  state.starts.set(41, 'new-start');
  state.commands.set(41, 'different command');
  expect(inspectManagedProcess({ pid: 41, startTime: 'old-start', command: 'wrapper' })).toBe(
    'ownership-lost',
  );
});

test('terminates the exact captured process tree without path guessing', async () => {
  for (const [pid, start, command] of [
    [41, 'root-start', 'wrapper'],
    [42, 'child-start', 'recorder child'],
  ] as const) {
    state.alive.set(pid, true);
    state.starts.set(pid, start);
    state.commands.set(pid, command);
  }
  await expect(
    terminateManagedProcessSet([
      { pid: 41, startTime: 'root-start', command: 'wrapper' },
      { pid: 42, startTime: 'child-start', command: 'recorder child' },
    ]),
  ).resolves.toBe('terminated');
  expect(state.signaled[0]).toEqual({ pids: [41, 42], signal: 'SIGINT' });
});
