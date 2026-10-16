import { beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { appleRunnerTestHost } from '../test-host.ts';
import { XCODE_SELECT_LINK_PATH } from '../apple-runner-platform.ts';
import type { ExecOptions, ExecResult } from '@agent-device/host-kit/command';

export const STUBBED_APPLE_TOOLCHAIN = {
  xcodeVersion: '26.2',
  xcodeBuildVersion: '17C52',
  sdkVersion: '26.2',
  sdkBuildVersion: '23C53',
} as const;

const STUBBED_SELECTED_DEVELOPER_DIR = '/Applications/Xcode-Stub.app/Contents/Developer';

export function selectedDeveloperDirResult(developerDir: string): ExecResult {
  return { exitCode: 0, stdout: `${developerDir}\n`, stderr: '' };
}

export function appleToolchainProbeResult(command: string, args: readonly string[]): ExecResult {
  if (command === 'xcode-select' && args[0] === '-p') {
    return selectedDeveloperDirResult(STUBBED_SELECTED_DEVELOPER_DIR);
  }
  if (command === 'xcodebuild' && args[0] === '-version') {
    return {
      exitCode: 0,
      stdout: `Xcode ${STUBBED_APPLE_TOOLCHAIN.xcodeVersion}\nBuild version ${STUBBED_APPLE_TOOLCHAIN.xcodeBuildVersion}\n`,
      stderr: '',
    };
  }
  if (command === 'xcrun' && args.includes('--show-sdk-build-version')) {
    return { exitCode: 0, stdout: `${STUBBED_APPLE_TOOLCHAIN.sdkBuildVersion}\n`, stderr: '' };
  }
  if (command === 'xcrun' && args.includes('--show-sdk-version')) {
    return { exitCode: 0, stdout: `${STUBBED_APPLE_TOOLCHAIN.sdkVersion}\n`, stderr: '' };
  }
  throw new Error(`Unexpected Apple toolchain probe: ${command} ${args.join(' ')}`);
}

/**
 * Answers the runner cache's toolchain probes from a fixed toolchain, so cases that key the cache
 * neither read the host's Xcode nor depend on one existing. No client chooses a `DEVELOPER_DIR`, so
 * the selection a key probe resolves is the one the case scripts. Returns the mock so a case can
 * make a probe fail.
 */
export function stubAppleToolchainProbes(): ReturnType<typeof vi.fn> {
  stubAppleSelectionLink();
  const runCmdSync = vi.fn(appleToolchainProbeResult);
  beforeEach(() => {
    runCmdSync.mockImplementation(appleToolchainProbeResult);
    appleRunnerTestHost.update({
      runCmdSync,
      commandDeveloperDir: () => undefined,
    });
  });
  return runCmdSync;
}

/**
 * The host's default selection link as the Apple toolchain probes see it. Undefined keeps the link
 * unreadable, which sends every read down the `xcode-select -p` fallback a case already scripts; a
 * case that owns a link points it at a path it created.
 */
export const appleSelectionLink: { target: string | undefined } = { target: undefined };

/**
 * Hides the selection link of the machine running the suite, so a case decides the host's selection
 * rather than inheriting it. The real host has one, and where it points is not this suite's business.
 */
export function stubAppleSelectionLink(): void {
  const realRealpathSync = fs.realpathSync;
  beforeEach(() => {
    appleSelectionLink.target = undefined;
    vi.spyOn(fs, 'realpathSync').mockImplementation((target: fs.PathLike) => {
      if (String(target) !== XCODE_SELECT_LINK_PATH) return realRealpathSync(target);
      if (appleSelectionLink.target === undefined) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      }
      return realRealpathSync(appleSelectionLink.target);
    });
  });
}

/**
 * The fingerprint budget's clock, advanced only by an exec that blocks for the whole timeout it was
 * handed. Without it a mock that throws immediately proves nothing about a deadline: no time passes,
 * so every budget looks untouched however many attempts run.
 */
export function installToolchainProbeClock(): { nowMs: number } {
  const clock = { nowMs: 0 };
  appleRunnerTestHost.update({
    deadlineFromTimeoutMs: (timeoutMs: number) => {
      const startedAtMs = clock.nowMs;
      const expiresAtMs = startedAtMs + Math.max(0, timeoutMs);
      return {
        remainingMs: () => Math.max(0, expiresAtMs - clock.nowMs),
        elapsedMs: () => Math.max(0, clock.nowMs - startedAtMs),
        isExpired: () => expiresAtMs - clock.nowMs <= 0,
      };
    },
  });
  return clock;
}

/** An exec that blocked for its whole timeout and was then killed, as the exec layer reports it. */
export function blockForWholeTimeout(
  clock: { nowMs: number },
  command: string,
  args: readonly string[],
  options: ExecOptions,
): AppError {
  const timeoutMs = options.timeoutMs ?? 0;
  clock.nowMs += timeoutMs;
  return new AppError('COMMAND_FAILED', `${command} timed out after ${timeoutMs}ms`, {
    cmd: command,
    args,
    timeoutMs,
  });
}

/**
 * The execs that read the toolchain itself, as opposed to the `xcode-select -p` a read runs to
 * decide which fingerprint entry it belongs to. A case that says a cache hit must not re-read the
 * toolchain says nothing about that one exec, so it asserts through this.
 */
export function valueProbeCommands(calls: readonly (readonly unknown[])[]): string[] {
  return calls
    .filter(([command]) => command !== 'xcode-select')
    .map(([command]) => String(command));
}
