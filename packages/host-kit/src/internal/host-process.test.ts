import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  captureHostEnvironment,
  expandProcessTree,
  isProcessAlive,
  isProcessGroupAlive,
  judgeProcessIdentity,
  listHostProcesses,
  parseHostProcessList,
  readProcessCommand,
  readProcessStartTime,
  signalPidsBestEffort,
  uniquePositivePids,
} from './host-process.ts';

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

test('captureHostEnvironment copies the environment and reads the working directory once', () => {
  const source = {
    env: { HOME: '/home/a', EMPTY: undefined } as Record<string, string | undefined>,
    cwd: vi.fn(() => '/work'),
  };
  const host = captureHostEnvironment(source);

  source.env.HOME = '/home/b';
  source.env.ADDED = 'late';

  assert.deepEqual(host, { env: { HOME: '/home/a', EMPTY: undefined }, cwd: '/work' });
  assert.notEqual(host.env, source.env);
  assert.equal(source.cwd.mock.calls.length, 1);
});

// One row per verdict rule: `ours` needs every recorded claim read and matching.
test.each([
  ['both claims read and matching', { startTime: 'S1', matches: true }, ['S1', 'recorded'], 'ours'],
  ['only a start time recorded, read and matching', { startTime: 'S1' }, ['S1', null], 'ours'],
  ['only a command recorded, read and matching', { matches: true }, [null, 'recorded'], 'ours'],
  [
    'a matching command beside an unread start time',
    { startTime: 'S1', matches: true },
    [null, 'recorded'],
    'unverified',
  ],
  [
    'a matching start time beside an unread command',
    { startTime: 'S1', matches: true },
    ['S1', null],
    'unverified',
  ],
  ['nothing read', { startTime: 'S1', matches: true }, [null, null], 'unverified'],
  ['nothing recorded', {}, ['S1', 'recorded'], 'unverified'],
  [
    'a recorded start time beside a mismatching command',
    { startTime: 'S1', matches: true },
    ['S1', 'other'],
    'unverified',
  ],
  [
    'an unread recorded start time beside a mismatching command',
    { startTime: 'S1', matches: true },
    [null, 'other'],
    'unverified',
  ],
  [
    'a contradicted start time',
    { startTime: 'S1', matches: true },
    ['S2', 'recorded'],
    'reassigned',
  ],
  [
    'a mismatching command with no start time recorded',
    { matches: true },
    ['S1', 'other'],
    'reassigned',
  ],
] as const)('judgeProcessIdentity: %s', (_name, recorded, [startTime, command], verdict) => {
  const expected = {
    ...('startTime' in recorded ? { startTime: recorded.startTime } : {}),
    ...('matches' in recorded ? { matches: (observed: string) => observed === 'recorded' } : {}),
  };
  assert.equal(judgeProcessIdentity(expected, { startTime, command, zombie: false }), verdict);
});

test('judgeProcessIdentity reads a zombie as exited whatever else the host says', () => {
  assert.equal(
    judgeProcessIdentity({ startTime: 'S1' }, { startTime: 'S2', command: null, zombie: true }),
    'exited',
  );
});
