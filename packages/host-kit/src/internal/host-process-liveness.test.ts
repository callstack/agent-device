import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterEach, beforeEach, test, vi } from 'vitest';

const { mockRunCmdSync, mockRunCmd } = vi.hoisted(() => ({
  mockRunCmdSync: vi.fn(),
  mockRunCmd: vi.fn(),
}));

vi.mock('./exec.ts', async () => {
  const actual = await vi.importActual<typeof import('./exec.ts')>('./exec.ts');
  return { ...actual, runCmd: mockRunCmd, runCmdSync: mockRunCmdSync };
});

import {
  isProcessZombie,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
  readProcessStartTime,
  readProcessIdentities,
  readProcessIdentityFacts,
} from './host-process.ts';

function psReturns(stdout: string, exitCode = 0): void {
  mockRunCmdSync.mockReturnValue({ stdout, stderr: '', exitCode });
}

/** Answers the two batched identity reads: state and start time, and the command line. */
function psAnswersIdentity(rows: { identity?: string; command?: string }): void {
  mockRunCmd.mockImplementation(async (_cmd: string, args: string[]) => {
    const value = args[3] === 'pid=,command=' ? rows.command : rows.identity;
    return { stdout: value ?? '', stderr: '', exitCode: value === undefined ? 1 : 0 };
  });
}

const PINNED_PS_COMMANDS: readonly string[] = ['/bin/ps', '/run/current-system/sw/bin/ps'];

function psInstalledAt(installed: readonly string[]): void {
  vi.spyOn(fs, 'accessSync').mockImplementation((candidate) => {
    if (!installed.includes(String(candidate))) throw new Error(`ENOENT: ${String(candidate)}`);
  });
}

beforeEach(() => {
  const readFileSync = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) => {
    if (String(path).startsWith('/proc/')) {
      throw Object.assign(new Error('proc is unavailable in the ps fixture'), { code: 'ENOENT' });
    }
    return readFileSync(path, options);
  });
  mockRunCmdSync.mockReset();
  mockRunCmd.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('isProcessZombie detects the Z state code with trailing flags', () => {
  psReturns('ZN  \n');
  assert.equal(isProcessZombie(4242), true);
});

test('isProcessZombie treats running states and ps failures as not zombie', () => {
  psReturns('Ss  \n');
  assert.equal(isProcessZombie(4242), false);
  psReturns('', 1);
  assert.equal(isProcessZombie(4242), false);
  mockRunCmdSync.mockImplementation(() => {
    throw new Error('ps timed out');
  });
  assert.equal(isProcessZombie(4242), false);
});

test('isProcessZombie returns false for an invalid pid without invoking ps', () => {
  assert.equal(isProcessZombie(-1), false);
  assert.equal(mockRunCmdSync.mock.calls.length, 0);
});

test('reads many process identities from one ps snapshot', () => {
  psReturns(`4242 Ss   Mon Aug 10 20:00:00 2026
4343 ZN   Mon Aug 10 20:01:00 2026
`);

  const observations = readHostProcessIdentityObservations([4242, 4343, 4242]);

  assert.deepEqual(observations.get(4242), {
    state: 'Ss',
    startTime: 'Mon Aug 10 20:00:00 2026',
  });
  assert.deepEqual(observations.get(4343), {
    state: 'ZN',
    startTime: 'Mon Aug 10 20:01:00 2026',
  });
  assert.equal(mockRunCmdSync.mock.calls.length, 1);
  assert.ok(PINNED_PS_COMMANDS.includes(mockRunCmdSync.mock.calls[0]?.[0]));
  assert.deepEqual(mockRunCmdSync.mock.calls[0]?.[1], [
    '-p',
    '4242,4343',
    '-o',
    'pid=,state=,lstart=',
  ]);
});

test('the async snapshot answers the same observations from one awaited ps run', async () => {
  mockRunCmd.mockImplementation(async (_cmd: string, args: readonly string[]) => {
    assert.deepEqual(args, ['-p', '4242,4343', '-o', 'pid=,state=,lstart=']);
    return {
      stdout: `4242 Ss   Mon Aug 10 20:00:00 2026
4343 ZN   Mon Aug 10 20:01:00 2026
`,
      stderr: '',
      exitCode: 0,
    };
  });

  const observations = await readHostProcessIdentityObservationsAsync([4242, 4343, 4242]);

  assert.deepEqual(observations.get(4242), {
    state: 'Ss',
    startTime: 'Mon Aug 10 20:00:00 2026',
  });
  assert.deepEqual(observations.get(4343), {
    state: 'ZN',
    startTime: 'Mon Aug 10 20:01:00 2026',
  });
  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmdSync.mock.calls.length, 0, 'the async probe never blocks the loop');
});

test('an async snapshot that is not answered is unknown evidence, not an empty fleet', async () => {
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });
  assert.equal((await readHostProcessIdentityObservationsAsync([4242])).size, 0);
  mockRunCmd.mockRejectedValue(new Error('ps timed out'));
  assert.equal((await readHostProcessIdentityObservationsAsync([4242])).size, 0);
});

test('no pid to ask about means no process tool runs at all', async () => {
  assert.equal((await readHostProcessIdentityObservationsAsync([])).size, 0);
  assert.equal((await readHostProcessIdentityObservationsAsync([-1, 0])).size, 0);
  assert.equal(mockRunCmd.mock.calls.length, 0);
  assert.equal(mockRunCmdSync.mock.calls.length, 0);
});

test('the ownership read spends the budget its caller names on both batched reads', async () => {
  psAnswersIdentity({
    identity: '4242 Ss   Mon Aug 10 20:00:00 2026\n',
    command: '4242 /bin/simctl io recordVideo out.mp4\n',
  });

  const facts = await readProcessIdentityFacts(4242, 5_000);

  assert.deepEqual(facts, {
    startTime: 'Mon Aug 10 20:00:00 2026',
    command: '/bin/simctl io recordVideo out.mp4',
    zombie: false,
  });
  assert.deepEqual(
    mockRunCmd.mock.calls.map((call) => call[1]),
    [
      ['-p', '4242', '-o', 'pid=,state=,lstart='],
      ['-p', '4242', '-o', 'pid=,command='],
    ],
  );
  for (const call of mockRunCmd.mock.calls) {
    assert.equal(call[2]?.timeoutMs, 5_000);
  }
});

test('one identity read answers a whole fleet from two ps runs, on Linux and macOS output', async () => {
  // procps pads a one-digit day with a space; BSD ps on macOS prints the same lstart layout. The
  // command keeps its own spaces, and a pid the host did not list stays unknown.
  psAnswersIdentity({
    identity: [
      '  101 Ss   Mon Nov  9 10:00:00 2026',
      '  202 Z+   Tue Nov 10 08:30:00 2026',
      '',
    ].join('\n'),
    command: [
      '  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless',
      '  202 [chrome] <defunct>',
      '',
    ].join('\n'),
  });

  const facts = await readProcessIdentities([101, 202, 303, 101]);

  assert.deepEqual(
    [...facts.entries()],
    [
      [
        101,
        {
          startTime: 'Mon Nov  9 10:00:00 2026',
          command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless',
          zombie: false,
        },
      ],
      [202, { startTime: 'Tue Nov 10 08:30:00 2026', command: '[chrome] <defunct>', zombie: true }],
      [303, { startTime: null, command: null, zombie: null }],
    ],
  );
  assert.deepEqual(
    mockRunCmd.mock.calls.map((call) => call[1]),
    [
      ['-p', '101,202,303', '-o', 'pid=,state=,lstart='],
      ['-p', '101,202,303', '-o', 'pid=,command='],
    ],
  );
  assert.equal(mockRunCmdSync.mock.calls.length, 0, 'the identity read never blocks the loop');
});

test('the ownership read reports an unanswered host as unknown, not as absence', async () => {
  mockRunCmd.mockRejectedValue(new Error('/bin/ps timed out after 5000ms'));

  assert.deepEqual(await readProcessIdentityFacts(4242, 5_000), {
    startTime: null,
    command: null,
    zombie: null,
  });
});

test('the ownership read leaves the zombie question open when only the state is unreadable', async () => {
  psAnswersIdentity({ command: '4242 /bin/simctl io recordVideo out.mp4\n' });

  assert.deepEqual(await readProcessIdentityFacts(4242, 5_000), {
    startTime: null,
    command: '/bin/simctl io recordVideo out.mp4',
    zombie: null,
  });
});

test('the ownership read answers the zombie question from the state field', async () => {
  psAnswersIdentity({ identity: '4242 ZN x\n', command: '4242 y\n' });

  assert.deepEqual(await readProcessIdentityFacts(4242), {
    startTime: 'x',
    command: 'y',
    zombie: true,
  });
  assert.ok(PINNED_PS_COMMANDS.includes(mockRunCmd.mock.calls[0]?.[0]));
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.timeoutMs, 1_000);
});

test('a host without /bin/ps reads identity through the NixOS system profile procps', async () => {
  psInstalledAt(['/run/current-system/sw/bin/ps']);
  psReturns('4242 Ss   Mon Aug 10 20:00:00 2026\n');
  psAnswersIdentity({ identity: '4242 Ss x\n', command: '4242 y\n' });

  assert.equal(
    readHostProcessIdentityObservations([4242]).get(4242)?.startTime,
    'Mon Aug 10 20:00:00 2026',
  );
  assert.equal((await readProcessIdentityFacts(4242)).startTime, 'x');
  assert.equal(mockRunCmdSync.mock.calls[0]?.[0], '/run/current-system/sw/bin/ps');
  for (const call of mockRunCmd.mock.calls) {
    assert.equal(call[0], '/run/current-system/sw/bin/ps');
  }
});

test('a host with no pinned ps still runs /bin/ps and never resolves ps from PATH', () => {
  psInstalledAt([]);
  psReturns('', 1);

  assert.equal(isProcessZombie(4242), false);
  assert.equal(mockRunCmdSync.mock.calls[0]?.[0], '/bin/ps');
});

test('a host with both pinned ps binaries keeps running /bin/ps', () => {
  psInstalledAt(['/bin/ps', '/run/current-system/sw/bin/ps']);
  psReturns('Ss  \n');

  assert.equal(isProcessZombie(4242), false);
  assert.equal(mockRunCmdSync.mock.calls[0]?.[0], '/bin/ps');
});

for (const probe of ['single', 'sync', 'async'] as const) {
  test.skipIf(process.platform !== 'linux')(
    `Linux ${probe} identity survives a wall-clock step`,
    async () => {
      vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
        if (String(path) === '/proc/sys/kernel/random/boot_id') return 'test-boot\n';
        if (String(path) === '/proc/4242/stat') {
          return `4242 (a) b) S ${Array(18).fill('0').join(' ')} 5371442 0`;
        }
        throw new Error('ENOENT');
      });
      const read = async () => {
        if (probe === 'single') return readProcessStartTime(4242);
        const rows =
          probe === 'sync'
            ? readHostProcessIdentityObservations([4242])
            : await readHostProcessIdentityObservationsAsync([4242]);
        return rows.get(4242)?.startTime;
      };
      for (const time of ['Mon Nov  9 23:54:54 2026', 'Mon Nov  9 23:54:58 2026']) {
        const stdout = probe === 'single' ? time : `4242 Ss ${time}`;
        psReturns(stdout);
        mockRunCmd.mockResolvedValue({ stdout, stderr: '', exitCode: 0 });
        assert.equal(await read(), 'linux:test-boot:5371442');
      }
    },
  );
}

for (const [psState, procState, zombie] of [
  ['Z', 'S', false],
  ['S', 'Z', true],
] as const) {
  test.skipIf(process.platform !== 'linux')(
    `Linux state follows the /proc read that gave the start token (ps ${psState}, /proc ${procState})`,
    async () => {
      // A pid reused between the ps snapshot and the /proc read must not pair one lifetime's
      // start token with the other lifetime's state.
      vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
        if (String(path) === '/proc/sys/kernel/random/boot_id') return 'test-boot\n';
        if (String(path) === '/proc/4242/stat') {
          return `4242 (a) ${procState} ${Array(18).fill('0').join(' ')} 5371442 0`;
        }
        throw new Error('ENOENT');
      });
      const row = `4242 ${psState} Mon Nov  9 23:54:54 2026\n`;
      psReturns(row);
      psAnswersIdentity({ identity: row, command: '4242 y\n' });
      const expected = { state: procState, startTime: 'linux:test-boot:5371442' };

      assert.deepEqual(readHostProcessIdentityObservations([4242]).get(4242), expected);
      assert.deepEqual(
        (await readHostProcessIdentityObservationsAsync([4242])).get(4242),
        expected,
      );
      assert.deepEqual(await readProcessIdentityFacts(4242), {
        startTime: 'linux:test-boot:5371442',
        command: 'y',
        zombie,
      });
    },
  );
}

test.skipIf(process.platform !== 'linux')(
  'Linux identities fall back to lstart when proc is unreadable or malformed',
  async () => {
    for (const stat of [
      null,
      '4242 (broken) S 0',
      `4242 (broken) S ${Array(18).fill('0').join(' ')} nope`,
    ]) {
      vi.spyOn(fs, 'readFileSync').mockImplementation((path) => {
        if (String(path) === '/proc/sys/kernel/random/boot_id') return 'test-boot\n';
        if (stat === null) throw new Error('ENOENT');
        return stat;
      });
      psReturns('original lstart');
      assert.equal(readProcessStartTime(4242), 'original lstart');
      psReturns('4242 Ss original lstart');
      mockRunCmd.mockResolvedValue({ stdout: '4242 Ss original lstart', stderr: '', exitCode: 0 });
      assert.equal(
        readHostProcessIdentityObservations([4242]).get(4242)?.startTime,
        'original lstart',
      );
      assert.equal(
        (await readHostProcessIdentityObservationsAsync([4242])).get(4242)?.startTime,
        'original lstart',
      );
      vi.restoreAllMocks();
    }
  },
);
