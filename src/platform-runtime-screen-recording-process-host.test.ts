import { beforeEach, expect, test, vi } from 'vitest';
import type { HostCommandResult } from '@agent-device/contracts/platform-runtime-host';
import { listHostProcesses } from '@agent-device/host-kit/process';
import {
  inspectManagedProcess,
  terminateManagedProcessSet,
} from './platform-runtime-screen-recording-process-host.ts';

const state = vi.hoisted(() => ({
  alive: new Map<number, boolean>(),
  starts: new Map<number, string>(),
  commands: new Map<number, string>(),
  signaled: [] as Array<{ pids: readonly number[]; signal: NodeJS.Signals }>,
  budgetedProbeCalls: [] as number[],
  onSignal: undefined as (() => void) | undefined,
  processTable: async () => [
    { pid: 41, command: 'wrapper' },
    { pid: 42, ppid: 41, command: 'recorder child' },
  ],
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: (pid: number) => state.alive.get(pid) ?? false,
  readProcessIdentityFacts: async (pid: number, timeoutMs?: number) => {
    if (timeoutMs !== undefined) state.budgetedProbeCalls.push(timeoutMs);
    return {
      startTime: state.starts.get(pid) ?? null,
      command: state.commands.get(pid) ?? null,
      zombie: false,
    };
  },
  readProcessIdentities: async (pids: Iterable<number>, timeoutMs?: number) => {
    if (timeoutMs !== undefined) state.budgetedProbeCalls.push(timeoutMs);
    return new Map(
      [...pids].map((pid) => [
        pid,
        {
          startTime: state.starts.get(pid) ?? null,
          command: state.commands.get(pid) ?? null,
          zombie: false,
        },
      ]),
    );
  },
  listHostProcesses: vi.fn(state.processTable),
  signalPidsBestEffort: (pids: readonly number[], signal: NodeJS.Signals) => {
    state.signaled.push({ pids, signal });
    for (const pid of pids) state.alive.set(pid, false);
    state.onSignal?.();
    return pids.length;
  },
  waitForProcessExit: async (pid: number) => !(state.alive.get(pid) ?? false),
}));

beforeEach(() => {
  state.alive.clear();
  state.starts.clear();
  state.commands.clear();
  state.signaled.length = 0;
  state.budgetedProbeCalls.length = 0;
  state.onSignal = undefined;
  vi.mocked(listHostProcesses).mockImplementation(state.processTable);
});

// What a caller that polls can afford to spend on one probe: host-kit's own default.
const PROBE_POLL_TIMEOUT_MS = 1_000;

function recorder(
  pid: number,
  killed: string[] = [],
): Readonly<{
  child: Readonly<{ pid: number; kill(signal?: NodeJS.Signals | number): boolean }>;
  wait: Promise<HostCommandResult>;
}> {
  let settled: ((result: HostCommandResult) => void) | undefined;
  const wait = new Promise<HostCommandResult>((resolve) => {
    settled = resolve;
  });
  return {
    child: {
      pid,
      kill: (signal?: NodeJS.Signals | number) => {
        killed.push(String(signal ?? 'SIGTERM'));
        state.alive.set(pid, false);
        settled?.({ stdout: '', stderr: '', exitCode: 0 });
        return true;
      },
    },
    wait,
  };
}

test('rejects PID reuse when start time or full command changes', async () => {
  state.alive.set(41, true);
  state.starts.set(41, 'new-start');
  state.commands.set(41, 'different command');
  await expect(
    inspectManagedProcess({ pid: 41, startTime: 'old-start', command: 'wrapper' }),
  ).resolves.toBe('ownership-lost');
});

// A pid that left during one rung's grace period and was handed to another process must not take
// the next rung's signal.
test('a marker whose pid changes hands mid-ladder is never signaled again', async () => {
  state.alive.set(41, true);
  state.starts.set(41, 'root-start');
  state.commands.set(41, 'wrapper');
  vi.mocked(listHostProcesses).mockResolvedValue([]);
  const reuse = vi.fn(() => {
    state.alive.set(41, true);
    state.starts.set(41, 'reused-start');
  });
  state.onSignal = reuse;

  await expect(
    terminateManagedProcessSet([{ pid: 41, startTime: 'root-start', command: 'wrapper' }]),
  ).resolves.toBe('ownership-lost');

  expect(state.signaled.map(({ signal }) => signal)).toEqual(['SIGINT']);
  expect(reuse).toHaveBeenCalledOnce();
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

test('asks for a real probe budget when the answer decides who is signaled', async () => {
  state.alive.set(41, true);
  state.starts.set(41, 'root-start');
  state.commands.set(41, 'wrapper');
  await expect(
    terminateManagedProcessSet([{ pid: 41, startTime: 'root-start', command: 'wrapper' }]),
  ).resolves.toBe('terminated');
  expect(state.budgetedProbeCalls.length).toBeGreaterThan(0);
  expect(Math.min(...state.budgetedProbeCalls)).toBeGreaterThan(PROBE_POLL_TIMEOUT_MS);
});

test('ends the recorder it spawned when the host cannot answer the identity probe', async () => {
  state.alive.set(41, true);
  const killed: string[] = [];
  await expect(
    terminateManagedProcessSet(
      [{ pid: 41, startTime: 'root-start', command: 'wrapper' }],
      recorder(41, killed),
    ),
  ).resolves.toBe('terminated');
  expect(killed).toEqual(['SIGINT']);
  expect(state.signaled[0]?.pids).toEqual([]);
});

test('refuses to signal a live process whose identity nobody can read', async () => {
  state.alive.set(41, true);
  await expect(
    terminateManagedProcessSet([{ pid: 41, startTime: 'root-start', command: 'wrapper' }]),
  ).resolves.toBe('ownership-lost');
  expect(state.signaled).toEqual([]);
});

test('refuses to end its own spawned pid once another process occupies it', async () => {
  state.alive.set(41, true);
  state.starts.set(41, 'another-process-start');
  state.commands.set(41, 'wrapper');
  const killed: string[] = [];
  await expect(
    terminateManagedProcessSet(
      [{ pid: 41, startTime: 'root-start', command: 'wrapper' }],
      recorder(41, killed),
    ),
  ).resolves.toBe('ownership-lost');
  expect(killed).toEqual([]);
  expect(state.signaled).toEqual([]);
});

test('ends its own recorder and still reports a marker it could not account for', async () => {
  state.alive.set(41, true);
  state.alive.set(42, true);
  const killed: string[] = [];
  await expect(
    terminateManagedProcessSet(
      [
        { pid: 41, startTime: 'root-start', command: 'wrapper' },
        { pid: 42, startTime: 'child-start', command: 'recorder child' },
      ],
      recorder(41, killed),
    ),
  ).resolves.toBe('ownership-lost');
  expect(killed).toEqual(['SIGINT']);
  expect(state.signaled[0]?.pids).toEqual([]);
  expect(state.alive.get(42)).toBe(true);
});

test('ends its own recorder when a marker the host cannot read has already exited', async () => {
  state.alive.set(41, true);
  const killed: string[] = [];
  await expect(
    terminateManagedProcessSet(
      [
        { pid: 41, startTime: 'root-start', command: 'wrapper' },
        { pid: 42, startTime: 'child-start', command: 'recorder child' },
      ],
      recorder(41, killed),
    ),
  ).resolves.toBe('terminated');
  expect(killed).toEqual(['SIGINT']);
});

test('ends the persisted markers when the host process table cannot be read', async () => {
  for (const [pid, start, command] of [
    [41, 'root-start', 'wrapper'],
    [42, 'child-start', 'recorder child'],
  ] as const) {
    state.alive.set(pid, true);
    state.starts.set(pid, start);
    state.commands.set(pid, command);
  }
  vi.mocked(listHostProcesses).mockRejectedValueOnce(new Error('/bin/ps timed out after 5000ms'));
  await expect(
    terminateManagedProcessSet([
      { pid: 41, startTime: 'root-start', command: 'wrapper' },
      { pid: 42, startTime: 'child-start', command: 'recorder child' },
    ]),
  ).resolves.toBe('terminated');
  expect(state.signaled[0]).toEqual({ pids: [41, 42], signal: 'SIGINT' });
});
