import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  expandProcessTree,
  isProcessAlive,
  isProcessGroupAlive,
  listHostProcesses,
  parseHostProcessList,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  stopPidsWithEscalation,
  uniquePositivePids,
} from '../host-process.ts';

test('isProcessAlive returns false for invalid pid', () => {
  assert.equal(isProcessAlive(-1), false);
});

test('isProcessGroupAlive returns false for invalid pid', () => {
  assert.equal(isProcessGroupAlive(-1), false);
});

test('readProcessStartTime returns value for current process', () => {
  const startTime = readProcessStartTime(process.pid);
  if (startTime === null) {
    assert.equal(readProcessCommand(process.pid), null);
    return;
  }
  assert.ok(startTime.length > 0);
});

test('host process parser preserves command text after pid and parent pid', () => {
  assert.deepEqual(
    parseHostProcessList(
      [
        '  101     1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '  202   101 /tmp/chrome --type=renderer --flag value',
        '  303     0 /tmp/orphaned',
        'not a process',
      ].join('\n'),
    ),
    [
      {
        pid: 101,
        ppid: 1,
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      },
      { pid: 202, ppid: 101, command: '/tmp/chrome --type=renderer --flag value' },
      { pid: 303, ppid: undefined, command: '/tmp/orphaned' },
    ],
  );
});

test('host process listing uses injected command runner and returns parsed ps rows', async () => {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number | undefined }> = [];
  const processes = await listHostProcesses({
    timeoutMs: 1234,
    runCommand: async (cmd, args, options) => {
      calls.push({ cmd, args, timeoutMs: options.timeoutMs });
      return { stdout: '  111     1 /usr/bin/node server.js\n', stderr: '', exitCode: 0 };
    },
  });

  assert.deepEqual(calls, [
    { cmd: 'ps', args: ['-ax', '-o', 'pid=,ppid=,command='], timeoutMs: 1234 },
  ]);
  assert.deepEqual(processes, [{ pid: 111, ppid: 1, command: '/usr/bin/node server.js' }]);
});

test('host process listing returns no processes when ps fails', async () => {
  const processes = await listHostProcesses({
    timeoutMs: 1234,
    runCommand: async () => ({ stdout: '  111     1 /usr/bin/node\n', stderr: '', exitCode: 1 }),
  });

  assert.deepEqual(processes, []);
});

test('process tree expansion includes descendants of matched roots', () => {
  const expanded = expandProcessTree(
    [101],
    [
      { pid: 101, ppid: 1, command: 'chrome' },
      { pid: 201, ppid: 101, command: 'Chrome Helper --type=renderer' },
      { pid: 301, ppid: 201, command: 'Chrome Helper --type=gpu' },
      { pid: 999, ppid: 1, command: 'Google Chrome' },
    ],
  );

  assert.deepEqual(
    expanded.map((processInfo) => processInfo.pid),
    [101, 201, 301],
  );
});

test('positive pid filtering de-duplicates invalid values and optional excluded pid', () => {
  assert.deepEqual(uniquePositivePids([3, -1, 0, 3, 4, 5], { excludePid: 4 }), [3, 5]);
});

test('best-effort signaling ignores invalid, current, and failed pids', () => {
  const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const numericPid = Number(pid);
    calls.push({ pid: numericPid, signal });
    if (numericPid === 202) {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  });

  try {
    assert.equal(signalPidsBestEffort([101, -1, 101, process.pid, 202], 'SIGTERM'), 1);
    assert.deepEqual(calls, [
      { pid: 101, signal: 'SIGTERM' },
      { pid: 202, signal: 'SIGTERM' },
    ]);
  } finally {
    killSpy.mockRestore();
  }
});

test('pid escalation sends TERM, then KILL only to live pids', async () => {
  vi.useFakeTimers();
  const alivePids = new Set([101, 202, 303]);
  const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
  const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    const numericPid = Number(pid);
    calls.push({ pid: numericPid, signal });
    if (signal === 'SIGTERM' && numericPid === 202) alivePids.delete(numericPid);
    if (signal === 'SIGKILL') alivePids.delete(numericPid);
    if (signal === 0 && !alivePids.has(numericPid)) {
      const error = new Error('not found') as NodeJS.ErrnoException;
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  });

  try {
    const stopped = stopPidsWithEscalation({
      pids: [101, 202, 101, -1, process.pid, 303],
      termTimeoutMs: 1_500,
      killTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await stopped;

    assert.deepEqual(
      calls.filter((call) => call.signal === 'SIGTERM').map((call) => call.pid),
      [101, 202, 303],
    );
    assert.deepEqual(
      calls.filter((call) => call.signal === 'SIGKILL').map((call) => call.pid),
      [101, 303],
    );
  } finally {
    killSpy.mockRestore();
    vi.useRealTimers();
  }
});

test('pid escalation returns immediately for an empty pid set', async () => {
  vi.useFakeTimers();
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

  try {
    await stopPidsWithEscalation({
      pids: [-1, 0, process.pid],
      termTimeoutMs: 1_500,
      killTimeoutMs: 1_000,
    });

    assert.equal(killSpy.mock.calls.length, 0);
  } finally {
    killSpy.mockRestore();
    vi.useRealTimers();
  }
});
