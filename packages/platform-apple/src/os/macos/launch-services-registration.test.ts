import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd, type ExecResult } from '@agent-device/host-kit/command';
import { mkdtempForTest } from '../../__tests__/tmp-dir.ts';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('@agent-device/host-kit/diagnostics', () => ({ emitDiagnostic: vi.fn() }));

import { setTimeout as sleep } from 'node:timers/promises';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { createLocalAppleMacOsHostProvider } from './host-provider.ts';
import type { AppleToolCommandExecutor } from '../../core/tool-provider-types.ts';

const BUNDLE_ID = 'com.example.demo';
const DEMO_BUNDLE = '/Users/dev/DerivedData/Demo.app';
const DEMO_PLIST = `${DEMO_BUNDLE}/Contents/Info.plist`;
const GHOST_BUNDLE = '/Applications/Ghost.app';
const GHOST_PLIST = `${GHOST_BUNDLE}/Contents/Info.plist`;
/** A real bundle directory may contain the `: ` that plutil puts between a name and its message. */
const COLON_BUNDLE = '/Applications/My App: Pro.app';
const COLON_PLIST = `${COLON_BUNDLE}/Contents/Info.plist`;
const LAUNCH_SERVICES_TOOL = '/usr/bin/lsappinfo';
/** The probe reads the process table through the same executor seam, under this command. */
const PROCESS_TABLE_TOOL = 'ps';
const PROCESS_TABLE_ARGS = ['-ax', '-o', 'pid=,ppid=,command='];
const LAUNCH_SERVICES_READ_CAP_MS = 1_000;
const BUNDLE_ID_CAP_MS = 1_500;
const PROCESS_TABLE_CAP_MS = 2_000;

/** `lsappinfo find` prints every instance it lists as an `ASN:` token, space-separated on one line. */
const REGISTERED = 'ASN:0x0-0x1234-"Demo": ASN:0x0-0x1244-"Demo":\n';

/** The `ps` rows the fake host answers with, as the tool prints them: `pid ppid command`. */
const processTable = { stdout: '' };

function psRows(rows: ReadonlyArray<readonly [pid: number, command: string]>): string {
  return rows.map(([pid, command]) => `${pid}     1 ${command}\n`).join('');
}

type RecordedCall = Readonly<{ cmd: string; args: string[]; timeoutMs: number | undefined }>;

type Stub = Partial<ExecResult> | Error;

/**
 * The host tools one bundle open reads — `lsappinfo`, `ps`, `plutil`, and `open` itself — answered
 * per call through the one executor seam the probe runs end to end, with every call and the budget
 * it was given recorded in order. An `Error` answer throws, the way a missing tool throws at the
 * real seam. `ps` answers with the current process table unless the responder overrides it, so a
 * test can make the scan throw, fail, or time out like any other read.
 */
function fakeMacHost(respond: (call: RecordedCall, index: number) => Stub = () => ({})): {
  runCommand: AppleToolCommandExecutor;
  calls: RecordedCall[];
  transcript(): Array<{ cmd: string; args: string[] }>;
} {
  const calls: RecordedCall[] = [];
  const runCommand: AppleToolCommandExecutor = async (cmd, args, options) => {
    const call = { cmd, args, timeoutMs: options?.timeoutMs };
    const index = calls.push(call) - 1;
    const answer = respond(call, index);
    if (answer instanceof Error) throw answer;
    const fallback = cmd === PROCESS_TABLE_TOOL ? { stdout: processTable.stdout } : {};
    return { stdout: '', stderr: '', exitCode: 0, ...fallback, ...answer };
  };
  return {
    runCommand,
    calls,
    /** The calls without their budget, for an expectation that is only about which tools ran. */
    transcript: () => calls.map(({ cmd, args }) => ({ cmd, args })),
  };
}

/** The `ps` entry of a transcript, for asserting the budget the scan was armed with. */
function processTableCall(calls: readonly RecordedCall[]): RecordedCall | undefined {
  return calls.find((call) => call.cmd === PROCESS_TABLE_TOOL);
}

/** Two copies of the same bundle plus an unrelated app, none of them LaunchServices-listed. */
function runningCopies(): void {
  processTable.stdout = psRows([
    [1, '/sbin/launchd'],
    [4242, `${DEMO_BUNDLE}/Contents/MacOS/Demo -DevFlag`],
    [4243, `${DEMO_BUNDLE}/Contents/MacOS/Demo`],
    [4300, `${GHOST_BUNDLE}/Contents/MacOS/Ghost`],
  ]);
}

/** The opened bundle's copy plus a copy of a bundle whose directory name contains `": "`. */
function runningCopiesIncludingColonBundle(): void {
  processTable.stdout = psRows([
    [4242, `${DEMO_BUNDLE}/Contents/MacOS/Demo -DevFlag`],
    [4400, `${COLON_BUNDLE}/Contents/MacOS/My App: Pro`],
    // A shell one-liner quoting some bundle's executable path looks exactly like a bundle process by
    // path shape, so it reaches the batch as a candidate whose plist does not exist. This is the
    // row that makes an unreadable-bundle name show up on stderr on a real host.
    [4500, `/bin/zsh -c pkill -f ${DEMO_BUNDLE}/Contents/MacOS/Demo`],
  ]);
}

function noRunningApps(): void {
  processTable.stdout = psRows([[1, '/sbin/launchd']]);
}

function openBundle(runCommand: AppleToolCommandExecutor): Promise<void> {
  return createLocalAppleMacOsHostProvider(runCommand, async () => null).openBundle(BUNDLE_ID);
}

function registrationReads(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter((call) => call.cmd === LAUNCH_SERVICES_TOOL);
}

const mockSleep = vi.mocked(sleep);
const mockEmitDiagnostic = vi.mocked(emitDiagnostic);

beforeEach(() => {
  // The table resets with every test so a later test's `not.toHaveBeenCalled`-style expectation on
  // the scan does not depend on run order.
  processTable.stdout = '';
});

afterEach(() => {
  mockSleep.mockClear();
  mockEmitDiagnostic.mockClear();
});

test('openBundle runs open at once when LaunchServices already lists an instance', async () => {
  const { runCommand, calls, transcript } = fakeMacHost((call) =>
    call.cmd === LAUNCH_SERVICES_TOOL ? { stdout: REGISTERED } : {},
  );

  await openBundle(runCommand);

  // Attaching to a listed instance is `open -b`'s own job, so no process-table read and no poll
  // stands between this open and `open`.
  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
  // One read of the registration view, inside its own cap.
  expect(registrationReads(calls)[0]?.timeoutMs).toBeLessThanOrEqual(LAUNCH_SERVICES_READ_CAP_MS);
});

test('openBundle runs open at once when no process of the opened bundle runs', async () => {
  noRunningApps();
  const { runCommand, calls, transcript } = fakeMacHost();

  await openBundle(runCommand);

  // The first-launch case: nothing is listed, the process table holds no bundle whose identifier
  // matches, so this open is the launch and no plist of a candidate is read to prove a copy exists.
  // The scan itself runs through the same executor seam as every other probe read.
  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(processTableCall(calls)?.timeoutMs).toBe(PROCESS_TABLE_CAP_MS);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle waits for LaunchServices to list a copy that runs unlisted', async () => {
  runningCopies();
  let registrationReadsDone = 0;
  const { runCommand, calls, transcript } = fakeMacHost((call) => {
    if (call.cmd === LAUNCH_SERVICES_TOOL) {
      registrationReadsDone += 1;
      // The copy is listed on the first read of its own pid in the second poll.
      return registrationReadsDone > 3 ? { stdout: REGISTERED } : {};
    }
    if (call.cmd === 'plutil') {
      // One call answers every candidate bundle: a row per readable plist, and Ghost's unreadable
      // plist named on stderr and absent from stdout.
      expect(call.args).toEqual(['-extract', 'CFBundleIdentifier', 'raw', DEMO_PLIST, GHOST_PLIST]);
      return {
        stdout: 'com.example.demo\n',
        stderr: `${GHOST_PLIST}: Could not extract value, error: No value at that key path\n`,
        exitCode: 1,
      };
    }
    return {};
  });

  await openBundle(runCommand);

  // Every wait is pinned to the copies the process table found — both copies of the opened bundle,
  // so the wait ends on whichever one the registration names — and never on the unrelated app.
  expect(transcript().slice(0, -1)).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'plutil', args: ['-extract', 'CFBundleIdentifier', 'raw', DEMO_PLIST, GHOST_PLIST] },
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`, 'pid=4242'] },
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`, 'pid=4243'] },
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`, 'pid=4242'] },
  ]);
  expect(mockSleep).toHaveBeenCalledTimes(2);
  expect(transcript().at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  // Each probe read carries a budget: the registration reads their own cap, the identifier read
  // its larger one, and neither spends more than that.
  for (const read of registrationReads(calls)) {
    expect(read.timeoutMs).toBeLessThanOrEqual(LAUNCH_SERVICES_READ_CAP_MS);
  }
  expect(calls.find((call) => call.cmd === 'plutil')?.timeoutMs).toBeLessThanOrEqual(
    BUNDLE_ID_CAP_MS,
  );
});

test('openBundle never waits for a running copy of some other bundle', async () => {
  runningCopies();
  const { runCommand, transcript } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') {
      // Both candidates belong to other bundles, so this open really is a launch. The empty row is
      // a plist that carries the key with no value: plutil prints it with no stderr, so the row
      // count still lines up and the demo copy keeps its own identifier.
      return { stdout: '\ncom.ghost.app\n' };
    }
    return {};
  });

  await openBundle(runCommand);

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'plutil', args: ['-extract', 'CFBundleIdentifier', 'raw', DEMO_PLIST, GHOST_PLIST] },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle abandons an unusable bundle identifier read instead of guessing a copy', async () => {
  runningCopies();
  const { runCommand, calls } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') {
      // Neither plist is named as unreadable, yet only one row comes back for two paths: pairing
      // would shift one bundle's identifier onto another bundle's process, so no copy is inferred.
      return { stdout: 'com.example.demo\n', exitCode: 1 };
    }
    return {};
  });

  await openBundle(runCommand);

  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(registrationReads(calls)).toHaveLength(1);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle pairs rows with paths when an unreadable bundle name itself contains ": "', async () => {
  runningCopiesIncludingColonBundle();
  const { runCommand, calls } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') {
      // Every candidate but the opened bundle is unreadable, and the unreadable names are reported
      // the way the tool does it: the path unquoted, then `: `, then a message that contains `": "`
      // of its own. Pairing on the first `": "` would name a prefix of the real path, leave the
      // plist counted as readable, and discard this whole read - which is the whole wait, skipped.
      expect(call.args).toEqual([
        '-extract',
        'CFBundleIdentifier',
        'raw',
        DEMO_PLIST,
        COLON_PLIST,
        '/bin/zsh -c pkill -f /Users/dev/DerivedData/Demo.app/Contents/Info.plist',
      ]);
      return {
        stdout: 'com.example.demo\n',
        stderr:
          `${COLON_PLIST}: Could not extract value, error: No value at that key ` +
          'path, expected: a string\n' +
          '/bin/zsh -c pkill -f /Users/dev/DerivedData/Demo.app/Contents/Info.plist: ' +
          'The file "Info.plist" doesn\u2019t exist.\n',
        exitCode: 1,
      };
    }
    if (call.cmd === LAUNCH_SERVICES_TOOL && call.args.some((arg) => arg.startsWith('pid='))) {
      return { stdout: REGISTERED };
    }
    return {};
  });

  await openBundle(runCommand);

  // The copy is still found, so the wait runs and ends on its registration instead of opening blind.
  expect(registrationReads(calls).slice(1)).toEqual([
    {
      cmd: LAUNCH_SERVICES_TOOL,
      args: ['find', `bundleid=${BUNDLE_ID}`, 'pid=4242'],
      timeoutMs: expect.any(Number),
    },
  ]);
  expect(mockSleep).toHaveBeenCalledTimes(1);
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
});

test('openBundle still opens a copy LaunchServices never lists', async () => {
  runningCopies();
  const { runCommand, calls } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') return { stdout: 'com.example.demo\ncom.ghost.app\n' };
    return {};
  });

  await openBundle(runCommand);

  // Failing open is the only safe answer to a registration that never lands: refusing the open would
  // break every caller whose app registers late, and a wait can only ever delay a duplicate, never
  // cause one.
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(mockSleep).toHaveBeenCalledTimes(10);
});

test('openBundle ends the wait on a registration read that fails rather than reopening early', async () => {
  runningCopies();
  let polls = 0;
  const { runCommand, calls } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') return { stdout: 'com.example.demo\ncom.ghost.app\n' };
    if (call.cmd === '/usr/bin/lsappinfo' && call.args.some((arg) => arg.startsWith('pid='))) {
      polls += 1;
      // A transient failure mid-wait must not be read as "registered": that is exactly the moment
      // an `open -b` would duplicate. The bound, not the failure, ends this wait.
      return polls === 3 ? { exitCode: 1, stderr: 'lsappinfo: transient' } : {};
    }
    return {};
  });

  await openBundle(runCommand);

  expect(mockSleep).toHaveBeenCalledTimes(10);
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
});

test('openBundle treats a failing first registration read as an instance to attach to', async () => {
  const { runCommand, transcript } = fakeMacHost((call) =>
    call.cmd === LAUNCH_SERVICES_TOOL
      ? { exitCode: 1, stderr: 'lsappinfo: launch services error' }
      : {},
  );

  await openBundle(runCommand);

  // Nothing was learned, so nothing is inferred: no process-table scan, no wait.
  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle opens unchanged when the process-table read cannot run', async () => {
  runningCopies();
  const { runCommand, calls, transcript } = fakeMacHost((call) =>
    // The scan now runs through the provider's executor, so like every other probe read it can
    // fail outright. A ps that cannot spawn must end the probe, not be read as an empty table.
    call.cmd === PROCESS_TABLE_TOOL
      ? new AppError('TOOL_MISSING', 'Required macOS tool not found: ps')
      : {},
  );

  await openBundle(runCommand);

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(mockEmitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      level: 'warn',
      phase: 'macos_launch_services_registration_probe_failed',
      data: expect.objectContaining({ bundleId: BUNDLE_ID, reason: 'TOOL_MISSING' }),
    }),
  );
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle leaves the wait alone when the process-table read is killed at its budget', async () => {
  runningCopies();
  const { runCommand, transcript } = fakeMacHost((call) =>
    // The exec seam rejects a command it killed at its own timeoutMs. The probe shares one budget
    // across reads, so a scan killed mid-probe says nothing about what runs: no candidates, no
    // wait, and the open proceeds exactly as it did before the probe existed.
    call.cmd === PROCESS_TABLE_TOOL
      ? new AppError('COMMAND_FAILED', 'ps timed out after 2000ms', { timeoutMs: 2_000 })
      : {},
  );

  await openBundle(runCommand);

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockEmitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      level: 'warn',
      phase: 'macos_launch_services_registration_probe_failed',
      data: expect.objectContaining({ bundleId: BUNDLE_ID, reason: 'COMMAND_FAILED' }),
    }),
  );
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle treats a failed process-table exit as an unreadable table, not as no processes', async () => {
  runningCopies();
  const { runCommand, transcript } = fakeMacHost((call) =>
    call.cmd === PROCESS_TABLE_TOOL ? { exitCode: 1, stderr: 'ps: operation not permitted' } : {},
  );

  await openBundle(runCommand);

  // `listHostProcesses` answers a non-zero exit with no rows, which the probe reads the same way as
  // an empty answer: the read failed, and inferring "nothing runs" from it would skip the wait.
  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockEmitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      level: 'warn',
      phase: 'macos_launch_services_process_table_unreadable',
      data: { bundleId: BUNDLE_ID },
    }),
  );
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle reports a process table that answers nothing rather than reading it as empty', async () => {
  processTable.stdout = '';
  const { runCommand, transcript } = fakeMacHost((call) =>
    call.cmd === 'plutil' ? { stdout: 'com.example.demo\n' } : {},
  );

  await openBundle(runCommand);

  // A macOS host always has processes, so an empty answer is the read failing. Inferring "nothing is
  // running" from it would skip the wait and reproduce the duplicate this seam exists to prevent.
  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockEmitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      level: 'warn',
      phase: 'macos_launch_services_process_table_unreadable',
      data: { bundleId: BUNDLE_ID },
    }),
  );
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle spends its budget on reads rather than on a wait with nothing left to read', async () => {
  vi.useFakeTimers();
  runningCopies();
  const { runCommand, calls, transcript } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') {
      // A slow scan on a loaded host: by the time it answers, the probe's shared budget is nearly
      // gone. Spending the remainder on a 200 ms sleep and a read killed at 100 ms would spawn tools
      // that cannot answer, so the wait is left alone and the open runs.
      vi.advanceTimersByTime(2_400);
      return { stdout: 'com.example.demo\ncom.ghost.app\n' };
    }
    return {};
  });

  await openBundle(runCommand);
  vi.useRealTimers();

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    { cmd: 'plutil', args: ['-extract', 'CFBundleIdentifier', 'raw', DEMO_PLIST, GHOST_PLIST] },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(registrationReads(calls)).toHaveLength(1);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle arms every probe read with only the budget the deadline still allows', async () => {
  vi.useFakeTimers();
  runningCopies();
  const { runCommand, calls } = fakeMacHost((call) => {
    // A first read that is slow but still answers inside its own cap. What is left of the shared
    // budget after it is smaller than the caps of the two reads that follow, so each of those has to
    // be armed with the remainder rather than with its own cap: a read armed above what is left could
    // run past the budget that bounds this probe.
    if (call.cmd === LAUNCH_SERVICES_TOOL) {
      vi.advanceTimersByTime(1_900);
      return {};
    }
    // Neither candidate is the opened bundle, so the wait never starts and the reads stay two.
    return call.cmd === 'plutil' ? { stdout: '\ncom.ghost.app\n' } : {};
  });

  await openBundle(runCommand);
  vi.useRealTimers();

  expect(calls.map(({ cmd, timeoutMs }) => ({ cmd, timeoutMs }))).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, timeoutMs: LAUNCH_SERVICES_READ_CAP_MS },
    // The process-table read is armed through this same seam now, and its cap is the largest; with
    // 600 ms left it takes the remainder, the way the identifier read beside it does.
    { cmd: PROCESS_TABLE_TOOL, timeoutMs: 600 },
    { cmd: 'plutil', timeoutMs: 600 },
    { cmd: 'open', timeoutMs: undefined },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle skips a read whose share of the budget falls below what a tool can use', async () => {
  vi.useFakeTimers();
  runningCopies();
  const { runCommand, transcript } = fakeMacHost((call) => {
    // Only 50 ms of the shared budget is left. Arming a read with it would spawn a tool that cannot
    // answer in time, and a zero timeout turns into no timer at all, which is how a probe that is
    // meant to be bounded would stop bounding itself.
    if (call.cmd === LAUNCH_SERVICES_TOOL) {
      vi.advanceTimersByTime(2_450);
      return {};
    }
    return call.cmd === 'plutil' ? { stdout: 'com.example.demo\ncom.ghost.app\n' } : {};
  });

  await openBundle(runCommand);
  vi.useRealTimers();

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
  expect(mockEmitDiagnostic).not.toHaveBeenCalled();
});

test('openBundle reads identifiers only for candidates that are app bundles', async () => {
  processTable.stdout = psRows([
    [4242, `${DEMO_BUNDLE}/Contents/MacOS/Demo -DevFlag`],
    [4300, `${GHOST_BUNDLE}/Contents/MacOS/Ghost`],
    // An app extension and a driver extension are bundles of their own, and most rows carrying
    // `/Contents/MacOS/` on a real host are these and XPC services, whose identifiers match no app
    // anyone opens. Keeping them out is what keeps the batch the size of the running apps.
    [4600, `${DEMO_BUNDLE}/Contents/PlugIns/Widget.appex/Contents/MacOS/Widget`],
    [4700, '/opt/dext/driver.dext/Contents/MacOS/driver'],
  ]);
  const { runCommand, transcript } = fakeMacHost((call) =>
    call.cmd === 'plutil' ? { stdout: '\n\n' } : {},
  );

  await openBundle(runCommand);

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: PROCESS_TABLE_TOOL, args: PROCESS_TABLE_ARGS },
    {
      cmd: 'plutil',
      args: ['-extract', 'CFBundleIdentifier', 'raw', DEMO_PLIST, GHOST_PLIST],
    },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
});

test('openBundle keeps the wait when the last candidate reports an empty identifier', async () => {
  // `plutil` prints an empty row for a plist that carries the key with no value, so the trailing
  // newline of that row is data: the two rows still pair with the two candidates and the opened
  // bundle's copy is among them. Dropping every trailing newline instead would lose a row, discard
  // the read as unpairable, and hand the duplicate back.
  runningCopies();
  const { runCommand, transcript } = fakeMacHost((call) =>
    call.cmd === 'plutil' ? { stdout: 'com.example.demo\n\n' } : {},
  );

  await openBundle(runCommand);

  expect(transcript().at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(mockSleep).toHaveBeenCalledTimes(10);
});

test('openBundle leaves the open alone when the first registration read is killed at its budget', async () => {
  runningCopies();
  const { runCommand, transcript } = fakeMacHost((call) => {
    if (call.cmd === LAUNCH_SERVICES_TOOL && !call.args.some((arg) => arg.startsWith('pid='))) {
      // A slow first read says nothing about whether an instance is listed, so unlike a mid-wait
      // timeout it must not be read as "nothing is listed" either: that would scan the process table
      // of a host that is already slow and start a wait on evidence the read never gave.
      return new AppError('COMMAND_FAILED', 'lsappinfo timed out after 1000ms', {
        timeoutMs: 1_000,
      });
    }
    return {};
  });

  await openBundle(runCommand);

  expect(transcript()).toEqual([
    { cmd: LAUNCH_SERVICES_TOOL, args: ['find', `bundleid=${BUNDLE_ID}`] },
    { cmd: 'open', args: ['-b', BUNDLE_ID] },
  ]);
  expect(mockSleep).not.toHaveBeenCalled();
  expect(mockEmitDiagnostic).not.toHaveBeenCalled();
});

test('openBundle keeps waiting when one registration read is killed at its own budget', async () => {
  runningCopies();
  let killed = 0;
  const { runCommand, calls } = fakeMacHost((call) => {
    if (call.cmd === 'plutil') return { stdout: 'com.example.demo\ncom.ghost.app\n' };
    if (call.cmd === LAUNCH_SERVICES_TOOL && call.args.some((arg) => arg.startsWith('pid='))) {
      killed += 1;
      // The exec seam rejects a command it killed at its own `timeoutMs`, even one allowed to fail.
      // Reading that as "give up on the probe" would open the bundle at the first slow host read,
      // which is the moment an `open -b` duplicates.
      if (killed === 2) {
        return new AppError('COMMAND_FAILED', 'lsappinfo timed out after 100ms', {
          timeoutMs: 100,
        });
      }
      return {};
    }
    return {};
  });

  await openBundle(runCommand);

  expect(mockSleep).toHaveBeenCalledTimes(10);
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(mockEmitDiagnostic).not.toHaveBeenCalled();
});

test('openBundle opens unchanged and reports a probe whose registration tool cannot spawn', async () => {
  const { runCommand, calls } = fakeMacHost((call) =>
    call.cmd === LAUNCH_SERVICES_TOOL
      ? new AppError('TOOL_MISSING', 'Required macOS tool not found: /usr/bin/lsappinfo')
      : {},
  );

  await openBundle(runCommand);

  // The probe is an extra read on someone else's launch, so a host that cannot answer it at all gets
  // the open it would have had without the probe — with a diagnostic naming why, by typed code.
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(mockEmitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      level: 'warn',
      phase: 'macos_launch_services_registration_probe_failed',
      data: expect.objectContaining({ bundleId: BUNDLE_ID, reason: 'TOOL_MISSING' }),
    }),
  );
});

test('openBundle reports a probe that failed for a reason no typed code describes', async () => {
  const { runCommand, calls } = fakeMacHost((call) =>
    call.cmd === LAUNCH_SERVICES_TOOL ? new Error('lsappinfo killed by the host') : {},
  );

  await openBundle(runCommand);

  // The reason is keyed on a typed code, never on the error's text, so what is left when an error
  // carries no code is its own name rather than a guess scraped out of the message.
  expect(calls.at(-1)).toEqual({ cmd: 'open', args: ['-b', BUNDLE_ID] });
  expect(mockEmitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: 'macos_launch_services_registration_probe_failed',
      data: { bundleId: BUNDLE_ID, reason: 'probe_read_failed' },
    }),
  );
});

// `plutil -extract` answers one `-extract` for every plist it is given, in argument order, so one
// call can name every candidate bundle. This pins that batched shape against the real tool: a
// candidate set the probe cannot pair with the rows it gets back ends the whole fix, and scripted
// rows above cannot prove the tool actually behaves that way.
describe.skipIf(process.platform !== 'darwin')(
  'bundle identifier reads against the real plutil',
  () => {
    test('openBundle names every candidate plist in one real batch and waits on its own pid', async () => {
      // Three bundles written to disk, the opened target second and under a name with a space.
      // Their plists are real; only their being "running" is the mocked process table.
      const root = await mkdtempForTest('ad-3406-plutil-batch-');
      const bundle = async (name: string, bundleId: string): Promise<string> => {
        const bundlePath = path.join(root, name);
        await mkdir(path.join(bundlePath, 'Contents'), { recursive: true });
        await writeFile(
          path.join(bundlePath, 'Contents', 'Info.plist'),
          '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
            '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
            '<plist version="1.0"><dict><key>CFBundleIdentifier</key>' +
            `<string>${bundleId}</string></dict></plist>\n`,
        );
        return bundlePath;
      };
      const other = await bundle('Other.app', 'com.example.other');
      const target = await bundle('My Target.app', BUNDLE_ID);
      const spaced = await bundle('Late Night.app', 'com.example.late-night');
      processTable.stdout = psRows([
        [4300, `${other}/Contents/MacOS/Other`],
        [4242, `${target}/Contents/MacOS/My Target -ProofFlag`],
        [4301, `${spaced}/Contents/MacOS/Late Night`],
      ]);

      const registrationReadsMade: string[][] = [];
      // plutil runs for real through the exec seam. The LaunchServices view, the process table and
      // `open` itself stay scripted: an unlisted-then-listed registration cannot be arranged with a
      // real bundle that is not actually running, and a real `open` would launch a real copy. Only
      // the target's own pid ever reports an ASN, so the wait ends only if pairing handed the probe
      // that pid.
      const runCommand: AppleToolCommandExecutor = async (cmd, args, options) => {
        if (cmd === 'open') return { exitCode: 0, stdout: '', stderr: '' };
        if (cmd === PROCESS_TABLE_TOOL) {
          return { exitCode: 0, stdout: processTable.stdout, stderr: '' };
        }
        if (cmd === LAUNCH_SERVICES_TOOL) {
          registrationReadsMade.push(args);
          const pinned = args.at(-1) === 'pid=4242';
          const registered =
            pinned && registrationReadsMade.filter((read) => read.at(-1) === 'pid=4242').length > 1;
          return {
            exitCode: 0,
            stdout: registered ? 'ASN:0x0-0x1234-"My Target":\n' : '',
            stderr: '',
          };
        }
        return await runCmd(cmd, args, options);
      };

      try {
        await openBundle(runCommand);

        // The wait ended on pid 4242 — the target's process — which only happens if the real
        // batch paired the target's identifier with the target's path among the three rows.
        expect(registrationReadsMade).toEqual([
          ['find', `bundleid=${BUNDLE_ID}`],
          ['find', `bundleid=${BUNDLE_ID}`, 'pid=4242'],
          ['find', `bundleid=${BUNDLE_ID}`, 'pid=4242'],
        ]);
        expect(mockSleep).toHaveBeenCalledTimes(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 10_000);
  },
);
