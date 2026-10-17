import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { resetAllProcessMemosForTests } from '@agent-device/kernel/ttl-memo';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';
import { IOS_SIMULATOR } from './device-fixtures.ts';
import { appleRunnerTestHost } from '../test-host.ts';
import {
  appleToolchainProbeResult,
  appleSelectionLink,
  blockForWholeTimeout,
  installToolchainProbeClock,
  selectedDeveloperDirResult,
  STUBBED_APPLE_TOOLCHAIN,
  stubAppleSelectionLink,
  valueProbeCommands,
} from './apple-toolchain-fixtures.ts';
import {
  memoizedRunnerXcodeVersion,
  requireRunnerToolchainFingerprint,
} from '../runner-toolchain-probe.ts';
import { createRunnerPhaseBudget, type RunnerPhaseBudget } from '../runner-phase-budget.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../apple-runner-platform.ts';

// The fingerprint memo is process-wide and the selection it keys on is host state, so these cases
// script both: `xcode-select -p` answers `selectedDeveloperDir`, and `xcodebuild` names the Xcode
// belonging to that selection.
const XCODE_A = '/Applications/Xcode-A.app/Contents/Developer';
const XCODE_B = '/Applications/Xcode-B.app/Contents/Developer';
const IPHONESIMULATOR_SDK = 'iphonesimulator';
const XCODE_B_BUILD_VERSION = '18A100';
const FINGERPRINT_TTL_MS = 10 * 60_000;
/** The ceiling one `xcode-select -p` attempt gets, below the 30 s a value probe gets. */
const XCODE_SELECT_TIMEOUT_MS = 2_000;

const runCmdSync = vi.fn();
let selectedDeveloperDir = XCODE_A;
let nowMs = 1_700_000_000_000;

stubAppleSelectionLink();

/** A scratch root the case's fake developer dirs and selection links live under. */
let tempRoot: string;

beforeEach(() => {
  resetAllProcessMemosForTests();
  selectedDeveloperDir = XCODE_A;
  tempRoot = mkdtempForTestSync('runner-selection-');
  runCmdSync.mockReset().mockImplementation(appleToolchainProbeResult);
  appleRunnerTestHost.update({
    runCmdSync,
    commandDeveloperDir: () => undefined,
  });
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * A developer dir the host can resolve, standing in for an installed Xcode at `dir`. Cases below
 * compare keys through the memo, and a dir that does not exist cannot be resolved to its real path,
 * so its key would fall back to the name rather than the resolved dir the case means.
 */
function realSelectionDir(dir: string): string {
  const created = path.join(tempRoot, dir);
  fs.mkdirSync(created, { recursive: true });
  fs.writeFileSync(path.join(created, '..', 'version.plist'), '<plist>build 1</plist>\n');
  return created;
}

/** Two Xcodes and the `sudo xcode-select -s` that moves the host's default selection between them. */
function scriptSelectableXcodes(): void {
  runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
    command === 'xcode-select'
      ? selectedDeveloperDirResult(selectedDeveloperDir)
      : command === 'xcodebuild' && selectedDeveloperDir === XCODE_B
        ? {
            exitCode: 0,
            stdout: `Xcode 27.0\nBuild version ${XCODE_B_BUILD_VERSION}\n`,
            stderr: '',
          }
        : appleToolchainProbeResult(command, args),
  );
}

function readFingerprint(
  budget?: RunnerPhaseBudget,
): ReturnType<typeof requireRunnerToolchainFingerprint> {
  return requireRunnerToolchainFingerprint(IPHONESIMULATOR_SDK, budget);
}

function attemptedTimeoutMs(command: string): number | undefined {
  const call = runCmdSync.mock.calls.find(([executed]) => executed === command);
  return (call?.[2] as ExecOptions | undefined)?.timeoutMs;
}

function blockResolutionForWholeTimeout(clock: { nowMs: number }): void {
  runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
    if (command !== 'xcode-select') return appleToolchainProbeResult(command, args);
    throw blockForWholeTimeout(clock, command, args, options);
  });
}

describe('the developer dir a toolchain fingerprint answers for', () => {
  test('a default selection that moved re-reads instead of answering the Xcode it replaced', () => {
    scriptSelectableXcodes();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    selectedDeveloperDir = XCODE_B;
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(XCODE_B_BUILD_VERSION);

    // The switch costs one resolution and one full re-read. The entry keyed on the old dir cannot
    // answer for the new one, which is what let a daemon serve the Xcode the host had left (#3300).
    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
      'xcode-select',
      'xcodebuild',
      'xcrun',
      'xcrun',
    ]);
  });

  test('a selection that comes back to a dir answers from that dir, not from the one it left', () => {
    scriptSelectableXcodes();
    readFingerprint();
    selectedDeveloperDir = XCODE_B;
    readFingerprint();

    selectedDeveloperDir = XCODE_A;
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);
  });

  test('each read resolves the selection it keys on, and one resolution is enough', () => {
    readFingerprint();
    runCmdSync.mockClear();

    readFingerprint();

    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual(['xcode-select']);
  });

  test('a failure report names the Xcode of the selection this process resolved last', () => {
    scriptSelectableXcodes();
    readFingerprint();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);

    selectedDeveloperDir = XCODE_B;
    readFingerprint();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('27.0');

    // Naming a selection is not worth waiting on one: only a fingerprint read resolves it.
    runCmdSync.mockClear();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('27.0');
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a selection that comes back to a dir answers its report from that dir as well', () => {
    scriptSelectableXcodes();
    readFingerprint();
    selectedDeveloperDir = XCODE_B;
    readFingerprint();

    selectedDeveloperDir = XCODE_A;
    // The read itself is a hit on A's entry, so it stores nothing; the report pointer still has to
    // follow the selection this read resolved, or it would blame B for an A-backed runner (#3300).
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a client that chooses DEVELOPER_DIR keys its read without resolving the default', () => {
    scriptSelectableXcodes();
    appleRunnerTestHost.update({ commandDeveloperDir: () => XCODE_A });

    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    expect(runCmdSync.mock.calls).toEqual([]);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a read that fails on its probes leaves a report naming the selection that stored one', () => {
    scriptSelectableXcodes();
    readFingerprint();

    selectedDeveloperDir = XCODE_B;
    runCmdSync.mockImplementation((command: string) =>
      command === 'xcode-select'
        ? selectedDeveloperDirResult(XCODE_B)
        : { exitCode: 1, stdout: '', stderr: 'xcodebuild: no such tool\n' },
    );
    expect(() => readFingerprint()).toThrow(/Could not read the Xcode toolchain versions/);

    // XCODE_B stored nothing, so the only report still owed an answer is the one made under XCODE_A.
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a selection that will not resolve reads a fingerprint and caches nothing for it', () => {
    const unresolvable = (): ExecResult => ({
      exitCode: 72,
      stdout: '',
      stderr: 'xcode-select: error: no developer directory\n',
    });
    runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
      command === 'xcode-select' ? unresolvable() : appleToolchainProbeResult(command, args),
    );

    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    runCmdSync.mockClear();
    // Nothing is cached under an unknown dir: the next read cannot tell which Xcode the entry would
    // answer for, so it pays the probes again rather than risking another selection's answer.
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
      'xcode-select',
      'xcodebuild',
      'xcrun',
      'xcrun',
    ]);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBeUndefined();
  });

  test('a warm read resolves its key from the selection link without spawning anything', () => {
    appleSelectionLink.target = realSelectionDir(XCODE_A);
    readFingerprint();
    runCmdSync.mockClear();

    readFingerprint();

    // The link is what a warm read reads, so the memo costs no process at all. `xcode-select -p` is
    // the fallback, not the per-read cost, which is what made the key change expensive before.
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a selection link naming a toolchain answers from that toolchain, not from xcode-select', () => {
    appleSelectionLink.target = realSelectionDir(XCODE_A);
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    // The two sources disagree, which is what a host whose selection moved without its link keeping
    // up looks like. The link is what `xcode-select -s` writes, so it is the one that names it.
    scriptSelectableXcodes();
    selectedDeveloperDir = XCODE_B;
    runCmdSync.mockClear();

    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a selection link moved to another developer dir moves the key with it', () => {
    appleSelectionLink.target = realSelectionDir(XCODE_A);
    readFingerprint();

    appleSelectionLink.target = realSelectionDir(XCODE_B);
    runCmdSync.mockClear();

    // The entry under the dir the host left cannot answer for the dir it moved to.
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
    expect(runCmdSync.mock.calls.some(([command]) => command === 'xcode-select')).toBe(false);
  });

  test('a bundle swapped behind a stable selection path moves the key', () => {
    // What a tool like xcodes does: it replaces the Xcode.app bundle, so the selection keeps naming
    // the same path while the toolchain behind it changes. Keying on the link's raw target would
    // keep answering for the Xcode that path used to reach, so the key follows the real dir.
    const stable = path.join(tempRoot, 'Xcode.app');
    const first = path.join(tempRoot, 'Xcode-1.app');
    const second = path.join(tempRoot, 'Xcode-2.app');
    for (const bundle of [first, second]) {
      fs.mkdirSync(path.join(bundle, 'Contents', 'Developer'), { recursive: true });
    }
    fs.symlinkSync(path.basename(first), stable);
    appleSelectionLink.target = stable;

    readFingerprint();
    fs.unlinkSync(stable);
    fs.symlinkSync(path.basename(second), stable);

    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
  });

  test('a selection reported with its trailing newline keys on the dir alone', () => {
    // `xcode-select -p` answers with a newline. A key that kept it would never match the dir a
    // client's DEVELOPER_DIR names, so one Xcode would look like two toolchains.
    const reported = realSelectionDir(XCODE_A);
    runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
      command === 'xcode-select'
        ? { exitCode: 0, stdout: `${reported}\n`, stderr: '' }
        : appleToolchainProbeResult(command, args),
    );

    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    runCmdSync.mockClear();

    appleRunnerTestHost.update({ commandDeveloperDir: () => reported });
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    // The client-named dir hit the entry the newline-built key stored, so nothing re-read.
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a bundle replaced in place at the same path moves the key', () => {
    // An App Store or installer update replaces the bundle without moving it, and the selection keeps
    // naming the same dir. Renewal on a hit means a key blind to that would keep serving the
    // fingerprint the update replaced for as long as the daemon stays busy, which is #3300 again.
    const selected = realSelectionDir(XCODE_A);
    appleSelectionLink.target = selected;
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    // The installer writes a new bundle: same path, new inode for the version file.
    const versionFile = path.join(selected, '..', 'version.plist');
    const replacedAt = fs.statSync(versionFile).mtimeMs + 1_000;
    fs.unlinkSync(versionFile);
    fs.writeFileSync(versionFile, '<plist>build 2</plist>\n');
    // Not left to the filesystem to make the two halves of the identity differ. On ext4 or tmpfs a
    // freed inode comes straight back out, and the two writes can land in one truncated millisecond,
    // which would leave the key untouched and this case red for a reason the fix has nothing to do
    // with. A replacement bundle is written after the one it replaces, so one second later says that
    // wherever the temp dir lives.
    fs.utimesSync(versionFile, new Date(replacedAt), new Date(replacedAt));

    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
  });

  test('a report reads only the memo, never the filesystem', () => {
    // A report runs after a failure, with no budget of its own to spend and no deadline to answer
    // to. Everything it needs is the key a real read already built, so a slow or vanished bundle
    // cannot make reporting wait, on either of its two paths.
    const selected = realSelectionDir(XCODE_A);
    appleSelectionLink.target = selected;
    readFingerprint();
    appleRunnerTestHost.update({ commandDeveloperDir: () => selected });
    readFingerprint();

    // The selection-link stub already spies realpathSync, so its history from the reads above is
    // cleared before the report is asked to answer.
    const statSync = vi.spyOn(fs, 'statSync').mockClear();
    const realpathSync = vi.spyOn(fs, 'realpathSync').mockClear();

    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
    appleRunnerTestHost.update({ commandDeveloperDir: () => undefined });
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);

    expect(statSync.mock.calls).toEqual([]);
    expect(realpathSync.mock.calls).toEqual([]);
  });

  test('each client-named selection keeps its own report across another client read', () => {
    // A daemon serves clients with different request-scoped DEVELOPER_DIRs at once. The second
    // client's read must not erase what the first one needs to report on, even though both of their
    // fingerprints are still cached.
    const dirA = realSelectionDir(XCODE_A);
    const dirB = realSelectionDir(XCODE_B);
    let chosen: string | undefined = dirA;
    appleRunnerTestHost.update({ commandDeveloperDir: () => chosen });
    runCmdSync.mockImplementation((command: string, args: readonly string[]) =>
      command === 'xcodebuild' && chosen === dirA
        ? { exitCode: 0, stdout: 'Xcode 15.1\nBuild version 1A111\n', stderr: '' }
        : appleToolchainProbeResult(command, args),
    );

    expect(readFingerprint().xcodeBuildVersion).toBe('1A111');
    chosen = dirB;
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);

    chosen = dirA;
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('15.1');
    chosen = dirB;
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);
  });

  test('a report for a client dir this process never read answers with nothing', () => {
    appleSelectionLink.target = realSelectionDir(XCODE_A);
    readFingerprint();

    const otherDir = realSelectionDir(XCODE_B);
    appleRunnerTestHost.update({ commandDeveloperDir: () => otherDir });
    runCmdSync.mockClear();

    // That dir has an entry only after a read resolves it, and looking one up would mean going and
    // stat-ing a bundle a report must not wait on.
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBeUndefined();
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a selection that answers nothing, or dies on exec, is no dir rather than a bad one', () => {
    for (const unanswered of [
      { exitCode: 0, stdout: '   \n', stderr: '' } satisfies ExecResult,
      null,
    ]) {
      runCmdSync.mockImplementation((command: string, args: readonly string[]) => {
        if (command !== 'xcode-select') return appleToolchainProbeResult(command, args);
        if (!unanswered) throw new Error('ENOENT: xcode-select not found');
        return unanswered;
      });
      expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    }

    expect(runCmdSync.mock.calls.filter(([command]) => command === 'xcode-select')).toHaveLength(2);
  });

  test('a default-selection read keys on what the resolution answers, not on a dir it saw before', () => {
    scriptSelectableXcodes();
    appleRunnerTestHost.update({ commandDeveloperDir: () => XCODE_A });
    readFingerprint();

    selectedDeveloperDir = XCODE_B;
    appleRunnerTestHost.update({ commandDeveloperDir: () => undefined });
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(XCODE_B_BUILD_VERSION);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);

    // The resolution is what puts this read back on the client-dir entry: without believing its
    // answer, a selection that came home would re-probe a toolchain this process already knows.
    selectedDeveloperDir = XCODE_A;
    runCmdSync.mockClear();
    expect(readFingerprint().xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);
  });
});

describe('the budget and cancellation a default-selection resolution answers to', () => {
  test('a resolution is capped below the value probe whose entry it decides', () => {
    readFingerprint();

    expect(attemptedTimeoutMs('xcode-select')).toBe(XCODE_SELECT_TIMEOUT_MS);
    expect(attemptedTimeoutMs('xcodebuild')).toBe(COLD_TOOLCHAIN_PROBE_TIMEOUT_MS);
  });

  test('an owning phase leaves the resolution half of what it has and no more', () => {
    installToolchainProbeClock();

    readFingerprint(createRunnerPhaseBudget(1_200, undefined));

    expect(attemptedTimeoutMs('xcode-select')).toBe(600);
  });

  test('a stalled resolution spends its own ceiling and never the fingerprint behind it', () => {
    const clock = installToolchainProbeClock();
    blockResolutionForWholeTimeout(clock);

    const fingerprint = readFingerprint();

    // A stalled `xcode-select` is a host not saying which Xcode it means, so the read continues
    // with no dir and pays for the whole fingerprint: the optional probe cannot cost the answer.
    expect(fingerprint.xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(clock.nowMs).toBe(XCODE_SELECT_TIMEOUT_MS);
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
  });

  test('a stalled resolution costs a cold-start retry its headroom, and only that', () => {
    const clock = installToolchainProbeClock();
    const xcodebuildTimeouts: number[] = [];
    runCmdSync.mockImplementation((command: string, args: string[], options: ExecOptions) => {
      if (command === 'xcode-select') throw blockForWholeTimeout(clock, command, args, options);
      if (command !== 'xcodebuild') return appleToolchainProbeResult(command, args);
      xcodebuildTimeouts.push(options.timeoutMs ?? 0);
      if (xcodebuildTimeouts.length > 1) return appleToolchainProbeResult(command, args);
      throw blockForWholeTimeout(clock, command, args, options);
    });

    const fingerprint = readFingerprint();

    // The same cold-start stall the budget is sized around, on a read that also lost 2 s deciding
    // its key: the retry runs on what is left, so one ceiling still bounds the whole fingerprint.
    expect(fingerprint.xcodeBuildVersion).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion);
    expect(xcodebuildTimeouts).toEqual([
      COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
      45_000 - COLD_TOOLCHAIN_PROBE_TIMEOUT_MS - XCODE_SELECT_TIMEOUT_MS,
    ]);
    expect(clock.nowMs).toBe(COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + XCODE_SELECT_TIMEOUT_MS);
  });

  test('a request aborted during the key reads is canceled even on a warm cache', () => {
    const request = new AbortController();
    appleSelectionLink.target = realSelectionDir(XCODE_A);
    readFingerprint(createRunnerPhaseBudget(undefined, request.signal));

    // The key's filesystem reads cannot be interrupted, so cancellation is observed after them. On a
    // warm cache the answer is already in hand, which is exactly when a hit could otherwise hide the
    // abort from the owner that asked for this request to stop.
    const statTheBundle = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
      request.abort();
      return statTheBundle(...args);
    }) as typeof fs.statSync);
    runCmdSync.mockClear();

    try {
      readFingerprint(createRunnerPhaseBudget(undefined, request.signal));
      assert.fail('expected the aborted request to be canceled at the key reads');
    } catch (error) {
      assert.ok(isRequestCanceledError(error), `got ${String(error)}`);
    }
    assert.deepEqual(valueProbeCommands(runCmdSync.mock.calls), []);
  });

  for (const cache of ['cold', 'warm'] as const) {
    test(`a request aborted while the resolution blocks is canceled with a ${cache} cache`, () => {
      const request = new AbortController();
      if (cache === 'warm') {
        readFingerprint();
        runCmdSync.mockClear();
      }
      runCmdSync.mockImplementation((command: string) => {
        if (command === 'xcode-select') {
          request.abort();
          throw new Error('spawnSync was killed');
        }
        throw new Error(`no value probe may run once the resolution was aborted: ${command}`);
      });

      try {
        readFingerprint(createRunnerPhaseBudget(undefined, request.signal));
        assert.fail('expected the aborted request to be canceled at the resolution');
      } catch (error) {
        assert.ok(isRequestCanceledError(error), `got ${String(error)}`);
      }
      assert.deepEqual(
        runCmdSync.mock.calls.filter(([command]) => command !== 'xcode-select').flat(),
        [],
      );
    });
  }
});

describe('the lifetime of a memoized toolchain fingerprint', () => {
  function advance(ms: number): void {
    nowMs += ms;
  }

  test('a hit renews the entry it answered from, because its key is still the selection', () => {
    readFingerprint();

    // The key names the dir this host selects, so a hit is itself evidence the entry is still the
    // answer for that host. #3300 asked to keep this renewal; the stale answer it could once serve
    // now costs a key change instead of a TTL.
    advance(FINGERPRINT_TTL_MS / 2);
    runCmdSync.mockClear();
    readFingerprint();
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);

    advance(FINGERPRINT_TTL_MS / 2);
    runCmdSync.mockClear();
    readFingerprint();
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual([]);
  });

  test('an entry no read takes expires at the TTL its storing read started', () => {
    readFingerprint();

    advance(FINGERPRINT_TTL_MS);
    runCmdSync.mockClear();
    readFingerprint();

    // Renewal is for entries in use. One that nothing has asked for goes away, which is also the
    // ceiling on how long a failure report can name a selection no request is using.
    expect(valueProbeCommands(runCmdSync.mock.calls)).toEqual(['xcodebuild', 'xcrun', 'xcrun']);
  });

  test('a hit well inside the TTL answers the read without touching the toolchain', () => {
    readFingerprint();
    runCmdSync.mockClear();

    advance(FINGERPRINT_TTL_MS / 4);
    readFingerprint();

    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual(['xcode-select']);
  });

  test('a report names no Xcode once the entry its selection recorded has expired', () => {
    scriptSelectableXcodes();
    readFingerprint();
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe(STUBBED_APPLE_TOOLCHAIN.xcodeVersion);

    // The selection stays recorded past expiry; what goes away is the entry behind it, and a report
    // answers with nothing rather than probing or naming another selection's Xcode.
    advance(FINGERPRINT_TTL_MS);
    runCmdSync.mockClear();

    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBeUndefined();
    expect(runCmdSync.mock.calls).toEqual([]);
  });

  test('a fingerprint expired under one selection is read again under the current one', () => {
    scriptSelectableXcodes();
    readFingerprint();
    selectedDeveloperDir = XCODE_B;

    advance(FINGERPRINT_TTL_MS);
    runCmdSync.mockClear();
    readFingerprint();

    expect(runCmdSync.mock.calls.map(([command]) => command)).toEqual([
      'xcode-select',
      'xcodebuild',
      'xcrun',
      'xcrun',
    ]);
    expect(memoizedRunnerXcodeVersion(IOS_SIMULATOR)).toBe('27.0');
  });
});
