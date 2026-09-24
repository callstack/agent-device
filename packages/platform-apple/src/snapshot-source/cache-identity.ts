import { isCommandTimeoutError, type ExecResult } from '@agent-device/host-kit/command';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import { snapshotSourceError, type SnapshotSourceError } from './errors.ts';
import { remainingSnapshotSourceMs, type SnapshotSourceDeadline } from './deadline.ts';
import type { SnapshotSourceHost } from './types.ts';

/**
 * The half of the bridge cache key the host answers for. `xcode` carries the version and the build,
 * which is what pins the Simulator SDK the bridge compiles against: that SDK ships inside the
 * selected `Xcode.app`, so it cannot move while `xcodebuild -version` reports the same build. The
 * identity therefore execs one Xcode-owned binary rather than two, because a toolchain probe that
 * cannot answer fails the whole job with nothing but a cache key at stake (#2712).
 */
export type HostToolchainIdentity = Readonly<{
  xcode: string;
  macosProductVersion: string;
  macosBuild: string;
  architecture: 'arm64' | 'x86_64';
}>;

export type SnapshotSourceToolchainIdentity = HostToolchainIdentity &
  Readonly<{
    simulatorRuntime: string;
  }>;

export const SNAPSHOT_BRIDGE_SOURCE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeRuntime.h',
  'SnapshotBridgeCapture.h',
  'SnapshotBridgeCapture.m',
] as const;
export const SNAPSHOT_BRIDGE_COMPILE_FILENAMES = [
  'SnapshotBridge.m',
  'SnapshotBridgeRuntime.m',
  'SnapshotBridgeCapture.m',
] as const;

/**
 * The host's active toolchain, independent of any simulator runtime: which Xcode `xcrun` resolves
 * against, the macOS build it runs on, and its architecture. Shared by every runtime clang build in
 * this package, so a cache keyed on it is invalidated exactly when switching `DEVELOPER_DIR` would
 * change what clang produces (#2796).
 */
export async function readHostToolchainIdentity(
  host: SnapshotSourceHost,
  deadline: SnapshotSourceDeadline,
): Promise<HostToolchainIdentity> {
  // The one Xcode-owned binary this read execs: SnapshotSourceToolchainIdentity says why (#2712).
  const xcode = await toolOutput(host, 'xcodebuild', ['-version'], deadline);
  const macosProductVersion = await toolOutput(host, 'sw_vers', ['-productVersion'], deadline);
  const macosBuild = await toolOutput(host, 'sw_vers', ['-buildVersion'], deadline);
  const architecture = await toolOutput(host, 'uname', ['-m'], deadline);
  if (architecture !== 'arm64' && architecture !== 'x86_64') {
    throw snapshotSourceError('unsupported', 'simulator-architecture-unsupported', {
      architecture,
    });
  }
  return { xcode, macosProductVersion, macosBuild, architecture };
}

export async function readSnapshotSourceToolchain(
  host: SnapshotSourceHost,
  simulatorRuntime: string,
  deadline: SnapshotSourceDeadline,
): Promise<SnapshotSourceToolchainIdentity> {
  const identity = await readHostToolchainIdentity(host, deadline);
  const runtime = simulatorRuntime.trim();
  if (!runtime) throw snapshotSourceError('unsupported', 'simulator-runtime-missing');
  return { ...identity, simulatorRuntime: runtime };
}

async function toolOutput(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  deadline: SnapshotSourceDeadline,
): Promise<string> {
  const result = await runToolchainProbe(host, command, args, deadline);
  if (result.exitCode !== 0) {
    throw snapshotSourceError('unsupported', 'toolchain-probe-failed', {
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 1024),
    });
  }
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw snapshotSourceError('unsupported', 'toolchain-probe-empty', { command });
  return output;
}

/** One exec, plus the single retry a first-exec stall can actually earn. */
const TOOLCHAIN_PROBE_ATTEMPTS = 2;

/**
 * Retries exactly once, and only the exec layer's structured timeout: a stall that finished while the
 * probe was being killed leaves an instant next exec of the same tool behind it, which is what
 * {@link COLD_TOOLCHAIN_PROBE_TIMEOUT_MS} was sized for (#2422). A stall that had not finished does
 * not clear that way, so the second timeout is reported as the host condition it is instead of
 * pretending the probe was worth running twice. Both attempts read one deadline, so the retry only
 * gets what the first stall left.
 */
async function runToolchainProbe(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  deadline: SnapshotSourceDeadline,
): Promise<ExecResult> {
  const attemptTimeoutsMs: number[] = [];
  let stalledBy: SnapshotSourceError | undefined;
  for (let attempt = 1; ; attempt += 1) {
    let timeoutMs: number;
    try {
      timeoutMs = Math.min(
        COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
        remainingSnapshotSourceMs(deadline, 'toolchain-probe-deadline'),
      );
    } catch (budgetError) {
      // A budget that closes between an attempt and this line is the stall already observed, and it
      // still names the probe that stalled rather than the arithmetic that noticed.
      throw stalledBy ?? budgetError;
    }
    attemptTimeoutsMs.push(timeoutMs);
    try {
      return await execToolchainProbe(host, command, args, deadline, timeoutMs);
    } catch (error) {
      if (!isCommandTimeoutError(error)) throw error;
      if (deadline.signal?.aborted) throw snapshotSourceError('cancelled', 'abort-signal');
      stalledBy = toolchainProbeStallError(command, attemptTimeoutsMs, error);
      if (attempt >= TOOLCHAIN_PROBE_ATTEMPTS) throw stalledBy;
    }
  }
}

/**
 * Says which probe could not answer, how many execs it took to learn that, and what each was armed
 * with. The exec layer's `<tool> timed out after Nms` alone reaches a job as an unattributed command
 * failure, which reads exactly like a device failure (#2712).
 */
function toolchainProbeStallError(
  command: string,
  attemptTimeoutsMs: readonly number[],
  cause: unknown,
): SnapshotSourceError {
  const attempts = attemptTimeoutsMs.length;
  return snapshotSourceError(
    'timeout',
    'toolchain-probe-stalled',
    {
      command,
      attemptTimeoutsMs: [...attemptTimeoutsMs],
      hint:
        `${command} did not answer within ${attemptTimeoutsMs[attempts - 1]}ms on ${attempts} ` +
        `attempt(s). A toolchain probe that cannot answer is a host condition rather than a ` +
        `toolchain defect: run \`${command}\` by hand until it answers, then retry.`,
    },
    cause,
  );
}

function execToolchainProbe(
  host: SnapshotSourceHost,
  command: string,
  args: string[],
  deadline: SnapshotSourceDeadline,
  timeoutMs: number,
): Promise<ExecResult> {
  return host.run(command, args, {
    allowFailure: true,
    signal: deadline.signal,
    timeoutMs,
  });
}
