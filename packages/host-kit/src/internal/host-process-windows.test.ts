import assert from 'node:assert/strict';
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
  listHostProcesses,
  readHostProcessIdentityObservations,
  readHostProcessIdentityObservationsAsync,
  readProcessCommand,
  readProcessIdentityFacts,
  readProcessStartTime,
} from './host-process.ts';
import { classifyOwnerLiveness } from './owner-identity.ts';

const DAEMON_START = '20261008123456789012';
const DAEMON_PID = 4242;
// One CIM row as a Windows host answers it: pid|ppid|creation|command.
const DAEMON_ROW = `${DAEMON_PID}|4321|${DAEMON_START}|C:\\Program Files\\node.exe  C:\\app\\dist\\src\\internal\\daemon.js`;

function windowsPlatform<T>(run: () => T): T;
function windowsPlatform<T>(run: () => Promise<T>): Promise<T>;
function windowsPlatform<T>(run: () => T | Promise<T>): T | Promise<T> {
  const previous = Object.getOwnPropertyDescriptor(process, 'platform');
  const restore = () => {
    if (previous) Object.defineProperty(process, 'platform', previous);
  };
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  let outcome: T | Promise<T>;
  try {
    outcome = run();
  } catch (error) {
    restore();
    throw error;
  }
  if (!(outcome instanceof Promise)) {
    restore();
    return outcome;
  }
  return outcome.finally(restore);
}

function cimAnswers(stdout: string, exitCode = 0): void {
  mockRunCmdSync.mockReturnValue({ stdout, stderr: '', exitCode });
}

beforeEach(() => {
  mockRunCmdSync.mockReset();
  mockRunCmd.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('the Windows start-time read asks CIM for the process birth, not for lstart', () => {
  windowsPlatform(() => {
    cimAnswers(`${DAEMON_ROW}\r\n`);
    assert.equal(readProcessStartTime(DAEMON_PID), DAEMON_START);
  });
  const call = mockRunCmdSync.mock.calls[0]!;
  assert.equal(call[0], 'powershell.exe');
  const command = String(call[1][3]);
  assert.match(command, /Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=4242'/);
  assert.match(command, /CreationDate/);
  assert.match(command, /CommandLine/);
});

test('the Windows command read answers the daemon-identity pattern from CommandLine', () => {
  windowsPlatform(() => {
    cimAnswers(`${DAEMON_ROW}\r\n`);
    assert.equal(
      readProcessCommand(DAEMON_PID),
      String.raw`C:\Program Files\node.exe  C:\app\dist\src\internal\daemon.js`,
    );
  });
});

test('the Windows host answers the zombie question without a process-table probe', () => {
  // A terminated Windows process leaves the CIM table rather than lingering in
  // it, so probing state per record could never reveal a zombie. The answer is
  // false with zero queries.
  windowsPlatform(() => {
    assert.equal(isProcessZombie(DAEMON_PID), false);
    assert.equal(isProcessZombie(4343), false);
  });
  assert.equal(mockRunCmdSync.mock.calls.length, 0);
});

test('a CIM query that names no row for the pid is unknown, not death', () => {
  windowsPlatform(() => {
    cimAnswers('');
    assert.equal(readProcessStartTime(DAEMON_PID), null);
    assert.equal(readProcessCommand(DAEMON_PID), null);
    assert.equal(isProcessZombie(DAEMON_PID), false);
  });
});

test('a failed or thrown CIM query is unknown evidence, as a failed ps is', () => {
  windowsPlatform(() => {
    cimAnswers('', 1);
    assert.equal(readProcessStartTime(DAEMON_PID), null);
    mockRunCmdSync.mockImplementation(() => {
      throw new Error('powershell.exe timed out');
    });
    assert.equal(readProcessStartTime(DAEMON_PID), null);
  });
});

test('the CIM row body never lets one null field raise, and pins the invariant culture', () => {
  windowsPlatform(() => {
    // The System Idle Process has no CreationDate. Formatting that row must
    // print an empty stamp, not raise: a terminating error mid-pipeline exits
    // 1 and blanks the ENTIRE snapshot, turning one odd process into unknown
    // evidence for every pid.
    cimAnswers(`0|0||System Idle Process\r\n4343|4321||cmd.exe\r\n${DAEMON_ROW}\r\n`);
    const observations = readHostProcessIdentityObservations([DAEMON_PID, 4343]);
    assert.deepEqual(observations.get(DAEMON_PID), { state: 'R', startTime: DAEMON_START });
    assert.equal(
      observations.get(4343),
      undefined,
      'a null-birth row is unknown, not a false birth',
    );
  });
  const command = String(mockRunCmdSync.mock.calls[0]![1][3]);
  assert.match(command, /if \(\$_\.CreationDate\)/, 'null birth prints empty instead of raising');
  assert.match(
    command,
    /CultureInfo\]::InvariantCulture/,
    'custom format follows the host calendar',
  );
});

test('the Windows batch snapshot answers one observation query for every selected pid', () => {
  windowsPlatform(() => {
    cimAnswers(
      `${DAEMON_ROW}\r\n4343|4321|20261008123500000000|C:\\Windows\\System32\\cmd.exe\r\n`,
    );
    const observations = readHostProcessIdentityObservations([DAEMON_PID, 4343, DAEMON_PID]);
    assert.deepEqual(observations.get(DAEMON_PID), {
      state: 'R',
      startTime: DAEMON_START,
    });
    assert.equal(observations.get(4343)?.startTime, '20261008123500000000');
  });
  assert.equal(mockRunCmdSync.mock.calls.length, 1);
  assert.match(String(mockRunCmdSync.mock.calls[0]![1][3]), /ProcessId=4242 OR ProcessId=4343/);
});

test('the async Windows batch snapshot awaits one CIM query instead of blocking', async () => {
  mockRunCmd.mockResolvedValue({ stdout: `${DAEMON_ROW}\r\n`, stderr: '', exitCode: 0 });
  const observations = await windowsPlatform(() =>
    readHostProcessIdentityObservationsAsync([DAEMON_PID, 4243]),
  );
  assert.deepEqual(observations.get(DAEMON_PID), { state: 'R', startTime: DAEMON_START });
  assert.equal(observations.get(4243), undefined);
  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmdSync.mock.calls.length, 0);
});

test('the Windows ownership read answers all three facts from one CIM query', async () => {
  mockRunCmd.mockResolvedValue({ stdout: `${DAEMON_ROW}\r\n`, stderr: '', exitCode: 0 });
  const facts = await windowsPlatform(() => readProcessIdentityFacts(DAEMON_PID, 5_000));
  assert.deepEqual(facts, {
    startTime: DAEMON_START,
    command: 'C:\\Program Files\\node.exe  C:\\app\\dist\\src\\internal\\daemon.js',
    zombie: false,
  });
  assert.equal(mockRunCmd.mock.calls.length, 1);
  assert.equal(mockRunCmd.mock.calls[0]![0], 'powershell.exe');
  assert.equal(mockRunCmd.mock.calls[0]![2]?.timeoutMs, 5_000);
});

test('the Windows ownership read budgets PowerShell startup over the ps default', async () => {
  mockRunCmd.mockResolvedValue({ stdout: DAEMON_ROW, stderr: '', exitCode: 0 });
  await windowsPlatform(() => readProcessIdentityFacts(DAEMON_PID));
  assert.equal(mockRunCmd.mock.calls[0]![2]?.timeoutMs, 2_000);
});

test('the Windows ownership read reports an unanswered host as unknown, not as absence', async () => {
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  assert.deepEqual(await windowsPlatform(() => readProcessIdentityFacts(DAEMON_PID, 5_000)), {
    startTime: null,
    command: null,
    zombie: null,
  });
  mockRunCmd.mockRejectedValue(new Error('powershell.exe timed out after 5000ms'));
  assert.deepEqual(await windowsPlatform(() => readProcessIdentityFacts(DAEMON_PID, 5_000)), {
    startTime: null,
    command: null,
    zombie: null,
  });
});

test('the Windows process list parses CIM rows through the injected command runner', async () => {
  const calls: Array<{ cmd: string; args: string[]; timeoutMs: number | undefined }> = [];
  const processes = await windowsPlatform(() =>
    listHostProcesses({
      timeoutMs: 1_234,
      runCommand: async (cmd, args, options) => {
        calls.push({ cmd, args, timeoutMs: options.timeoutMs });
        return {
          stdout: `\uFEFF0|0||System Idle Process\r\n${DAEMON_ROW}\r\n0|0||\r\nnot a row\r\n`,
          stderr: '',
          exitCode: 0,
        };
      },
    }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.cmd, 'powershell.exe');
  assert.match(
    String(calls[0]!.args[3]),
    /^\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8; Get-CimInstance -ClassName Win32_Process \|/,
  );
  assert.equal(calls[0]!.timeoutMs, 2_000);
  assert.deepEqual(processes, [
    {
      pid: DAEMON_PID,
      ppid: 4321,
      command: 'C:\\Program Files\\node.exe  C:\\app\\dist\\src\\internal\\daemon.js',
    },
  ]);
});

test('a live Windows owner matches its recorded CIM birth instead of staying unproven', () => {
  // This is the #3291 failure shape: with no Windows identity facts the owner
  // is recorded without a start time and every later ownership check stays
  // fail-closed while the daemon listens. With the CIM birth recorded, the
  // same checks prove the lifetime of this still-alive pid.
  windowsPlatform(() => {
    cimAnswers(`${process.pid}|4321|${DAEMON_START}|\r\n`);
    assert.equal(readProcessStartTime(process.pid), DAEMON_START);
    assert.equal(
      classifyOwnerLiveness({ owner: { pid: process.pid, startTime: DAEMON_START } }),
      'live',
      'a listening daemon with a CIM-recorded birth must classify as live',
    );
    // The same pid answering a different birth proves PID reuse, which the
    // null-start Windows failure could never report.
    cimAnswers(`${process.pid}|4321|20270101000000000000|\r\n`);
    assert.equal(
      classifyOwnerLiveness({ owner: { pid: process.pid, startTime: DAEMON_START } }),
      'owner-process-reused',
    );
  });
});
