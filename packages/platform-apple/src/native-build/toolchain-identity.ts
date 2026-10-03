import { isCommandTimeoutError, type ExecResult } from '@agent-device/host-kit/command';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import { nativeBuildError, NativeBuildError } from './errors.ts';
import { remainingNativeBuildMs, type NativeBuildDeadline } from './deadline.ts';
import type { NativeBuildHost } from './host.ts';

/**
 * The host's active toolchain, independent of any simulator runtime: which Xcode `xcrun` resolves
 * against, the macOS build it runs on, and its architecture. Shared by every runtime clang build in
 * this package, so a cache keyed on it is invalidated exactly when switching `DEVELOPER_DIR` would
 * change what clang produces (#2796). `xcode` carries the version and the build, which is what pins
 * the Simulator SDK the bridge compiles against: that SDK ships inside the selected `Xcode.app`, so
 * it cannot move while `xcodebuild -version` reports the same build. The identity therefore execs
 * one Xcode-owned binary rather than two, because a toolchain probe that cannot answer fails the
 * whole job with nothing but a cache key at stake (#2712).
 */
export type HostToolchainIdentity = Readonly<{
  xcode: string;
  macosProductVersion: string;
  macosBuild: string;
  architecture: 'arm64' | 'x86_64';
}>;

export async function readHostToolchainIdentity(
  host: NativeBuildHost,
  deadline: NativeBuildDeadline,
): Promise<HostToolchainIdentity> {
  const xcode = await toolOutput(host, 'xcodebuild', ['-version'], deadline);
  const macosProductVersion = await toolOutput(host, 'sw_vers', ['-productVersion'], deadline);
  const macosBuild = await toolOutput(host, 'sw_vers', ['-buildVersion'], deadline);
  const architecture = await hostCpuArchWithin(host, deadline);
  if (architecture !== 'arm64' && architecture !== 'x86_64') {
    throw nativeBuildError('unsupported', 'simulator-architecture-unsupported', { architecture });
  }
  return { xcode, macosProductVersion, macosBuild, architecture };
}

/**
 * The host arch is one per-process value shared by every caller, so a request cannot cancel its
 * probe; it stops waiting for it instead when it is cancelled or its budget runs out.
 */
async function hostCpuArchWithin(
  host: NativeBuildHost,
  deadline: NativeBuildDeadline,
): Promise<string> {
  const remainingMs = remainingNativeBuildMs(deadline, 'host-arch-deadline');
  const signal = deadline.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(nativeBuildError('timeout', 'host-arch-deadline')),
      remainingMs,
    );
    timer.unref?.();
    onAbort = () => reject(nativeBuildError('cancelled', 'abort-signal'));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([host.cpuArch(), ended]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

async function toolOutput(
  host: NativeBuildHost,
  command: string,
  args: string[],
  deadline: NativeBuildDeadline,
): Promise<string> {
  const result = await runToolchainProbe(host, command, args, deadline);
  if (result.exitCode !== 0) {
    throw nativeBuildError('unsupported', 'toolchain-probe-failed', {
      command,
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 1024),
    });
  }
  const output = (result.stdout || result.stderr).trim();
  if (!output) throw nativeBuildError('unsupported', 'toolchain-probe-empty', { command });
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
  host: NativeBuildHost,
  command: string,
  args: string[],
  deadline: NativeBuildDeadline,
): Promise<ExecResult> {
  const attemptTimeoutsMs: number[] = [];
  let stalledBy: NativeBuildError | undefined;
  for (let attempt = 1; ; attempt += 1) {
    let timeoutMs: number;
    try {
      timeoutMs = Math.min(
        COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
        remainingNativeBuildMs(deadline, 'toolchain-probe-deadline'),
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
      stalledBy = classifyToolchainProbeFailure(error, command, deadline, attemptTimeoutsMs);
      if (attempt >= TOOLCHAIN_PROBE_ATTEMPTS) throw stalledBy;
    }
  }
}

/**
 * Sorts a failed probe exec into the module's cancellation/stall contract: a raw exec-layer
 * cancellation (a mid-exec abort settles through `exec.ts` as `REQUEST_CANCELED`, not a timeout)
 * and a post-timeout abort both surface as the domain `cancelled` shape; anything but a structured
 * exec timeout rethrows unchanged; only an actual stall is handed back for the retry loop to count.
 */
function classifyToolchainProbeFailure(
  error: unknown,
  command: string,
  deadline: NativeBuildDeadline,
  attemptTimeoutsMs: readonly number[],
): NativeBuildError {
  if (isRequestCanceledError(error)) {
    throw nativeBuildError('cancelled', 'abort-signal', {}, error);
  }
  if (!isCommandTimeoutError(error)) throw error;
  if (deadline.signal?.aborted) throw nativeBuildError('cancelled', 'abort-signal');
  return toolchainProbeStallError(command, attemptTimeoutsMs, error);
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
): NativeBuildError {
  const attempts = attemptTimeoutsMs.length;
  return nativeBuildError(
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
  host: NativeBuildHost,
  command: string,
  args: string[],
  deadline: NativeBuildDeadline,
  timeoutMs: number,
): Promise<ExecResult> {
  return host.run(command, args, {
    allowFailure: true,
    signal: deadline.signal,
    timeoutMs,
  });
}
