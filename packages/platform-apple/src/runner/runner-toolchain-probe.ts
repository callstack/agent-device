import {
  AppError,
  createRequestCanceledError,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { TtlMemo } from '@agent-device/kernel/ttl-memo';
import {
  commandDeveloperDir,
  createTtlMemo,
  Deadline,
  isCommandTimeoutError,
  runCmdSync,
} from './host.ts';
import {
  COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
} from './apple-runner-platform.ts';
import {
  isRunnerPhaseBudgetExhaustedError,
  runnerPhaseBudgetExhaustedError,
  type RunnerPhaseBudget,
} from './runner-phase-budget.ts';

/**
 * Ceiling on the wall clock the whole toolchain fingerprint may spend, across all three
 * probes and their retries, when the owning phase carries no shorter budget: one stalled
 * probe, its warm retry, and the two probes still to run (#2422).
 */
const TOOLCHAIN_FINGERPRINT_BUDGET_MS = 45_000;
const TOOLCHAIN_PROBE_MAX_BUFFER = 128 * 1024;
const TOOLCHAIN_PROBE_DETAIL_MAX_LENGTH = 200;
const TOOLCHAIN_PROBE_HINT =
  'The Apple runner cache is keyed on the toolchain version, so a cache decision cannot be made without it. Retry once the host is less loaded, or check `xcode-select -p` and `xcodebuild -version`.';

/** Toolchain half of the runner cache key. Every field is a probed value. */
export type RunnerToolchainFingerprint = {
  xcodeVersion: string;
  xcodeBuildVersion: string;
  sdkName: string;
  sdkVersion: string;
  sdkBuildVersion: string;
};

type ToolchainProbeFailure = {
  probe: string;
  reason: 'probe_error' | 'nonzero_exit' | 'empty_output' | 'unparsable_output';
  detail: string;
};

type ProbeResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; failure: ToolchainProbeFailure };

/**
 * The remaining-time and cancellation view the probes consult: one per fingerprint read,
 * so the three probes and their retries share a single budget. A phase with no deadline
 * still gets {@link TOOLCHAIN_FINGERPRINT_BUDGET_MS} as the ceiling.
 *
 * `spawnSync` cannot be interrupted once it has started, so cancellation is observed
 * between attempts; the per-attempt cap is what bounds how long that takes.
 */
type ToolchainProbeClock = {
  /** Milliseconds the next attempt may block for; 0 once the budget is spent. */
  attemptTimeoutMs(): number;
  /** Throws the owning request's cancellation error once it has aborted. */
  throwIfCanceled(): void;
};

function createToolchainProbeClock(budget: RunnerPhaseBudget | undefined): ToolchainProbeClock {
  const phaseDeadline = budget?.deadline;
  const deadline = Deadline.fromTimeoutMs(
    Math.min(
      TOOLCHAIN_FINGERPRINT_BUDGET_MS,
      phaseDeadline ? phaseDeadline.remainingMs() : Number.POSITIVE_INFINITY,
    ),
  );
  return {
    attemptTimeoutMs: () =>
      Math.min(COLD_TOOLCHAIN_PROBE_TIMEOUT_MS, Math.floor(deadline.remainingMs())),
    throwIfCanceled: () => {
      if (budget?.signal?.aborted) {
        throw createRequestCanceledError({ phase: 'apple_toolchain_probe' });
      }
    },
  };
}

// Lazy: createTtlMemo is a host capability, and module evaluation happens
// before the composition root binds the host. Only a complete, parsed
// fingerprint is ever memoized, so nothing unavailable can outlive the probe
// that could not answer. The key carries a client-chosen DEVELOPER_DIR, so an
// entry expires once no request has used it for TOOLCHAIN_FINGERPRINT_TTL_MS:
// a dir no client uses any more must not stay for the daemon's lifetime. A hit
// renews the entry, so a failure report can name the Xcode a decision read for
// at least TOOLCHAIN_FINGERPRINT_TTL_MS after that read (the default start budget).
const TOOLCHAIN_FINGERPRINT_TTL_MS = 10 * 60_000;
let lazyToolchainFingerprintCache: TtlMemo<string, RunnerToolchainFingerprint> | undefined;
function toolchainFingerprintCache(): TtlMemo<string, RunnerToolchainFingerprint> {
  lazyToolchainFingerprintCache ??= createTtlMemo<string, RunnerToolchainFingerprint>({
    ttlMs: TOOLCHAIN_FINGERPRINT_TTL_MS,
    scheduleExpiry: true,
  });
  return lazyToolchainFingerprintCache;
}

/**
 * The toolchain half of the cache key. It also names the derived-data directory, so an
 * unreadable toolchain fails the cache decision instead of standing in for one.
 */
export function requireRunnerToolchainFingerprint(
  sdkName: string,
  budget: RunnerPhaseBudget | undefined,
): RunnerToolchainFingerprint {
  // Before the cache, not just before the probes: a hit must not hide a cancellation.
  const clock = createToolchainProbeClock(budget);
  clock.throwIfCanceled();
  const cacheKey = toolchainFingerprintCacheKey(sdkName);
  const cached = toolchainFingerprintCache().get(cacheKey);
  if (cached) {
    toolchainFingerprintCache().set(cacheKey, cached);
    return cached;
  }
  const fingerprint = readRunnerToolchainFingerprint(sdkName, clock);
  if (!fingerprint.ok) throw unavailableToolchainError(fingerprint.failures);
  toolchainFingerprintCache().set(cacheKey, fingerprint.value);
  return fingerprint.value;
}

/**
 * A daemon serves clients that select different Xcodes through `DEVELOPER_DIR`, so a fingerprint
 * read under one developer dir answers only for that dir. An empty dir means xcode-select's.
 */
function toolchainFingerprintCacheKey(sdkName: string): string {
  return `${commandDeveloperDir() ?? ''}\0${sdkName}`;
}

/**
 * The selected Xcode's version as this process's runner cache decision memoized it, for a failure
 * report that names it; undefined when no decision has read the toolchain in the last
 * `TOOLCHAIN_FINGERPRINT_TTL_MS`. Never probes: a report must not wait on the toolchain it
 * describes.
 */
export function memoizedRunnerXcodeVersion(device: DeviceInfo): string | undefined {
  return toolchainFingerprintCache().get(
    toolchainFingerprintCacheKey(
      resolveRunnerSdkName(resolveRunnerPlatformName(device), device.kind),
    ),
  )?.xcodeVersion;
}

function readRunnerToolchainFingerprint(
  sdkName: string,
  clock: ToolchainProbeClock,
):
  | { ok: true; value: RunnerToolchainFingerprint }
  | { ok: false; failures: readonly ToolchainProbeFailure[] } {
  const xcode = parseXcodeVersionOutput(runToolchainProbe('xcodebuild', ['-version'], clock));
  const sdkVersion = runToolchainProbe('xcrun', ['--sdk', sdkName, '--show-sdk-version'], clock);
  const sdkBuildVersion = runToolchainProbe(
    'xcrun',
    ['--sdk', sdkName, '--show-sdk-build-version'],
    clock,
  );
  if (!xcode.ok || !sdkVersion.ok || !sdkBuildVersion.ok) {
    return {
      ok: false,
      failures: [xcode, sdkVersion, sdkBuildVersion].flatMap((probe) =>
        probe.ok ? [] : [probe.failure],
      ),
    };
  }
  return {
    ok: true,
    value: {
      xcodeVersion: xcode.value.version,
      xcodeBuildVersion: xcode.value.buildVersion,
      sdkName,
      sdkVersion: sdkVersion.value,
      sdkBuildVersion: sdkBuildVersion.value,
    },
  };
}

function unavailableToolchainError(failures: readonly ToolchainProbeFailure[]): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Could not read the Xcode toolchain versions the Apple runner cache is keyed on (${failures
      .map((failure) => `${failure.probe}: ${failure.detail}`)
      .join('; ')})`,
    {
      reason: 'apple_toolchain_probe_unavailable',
      retriable: true,
      probes: failures,
      hint: TOOLCHAIN_PROBE_HINT,
    },
  );
}

function runToolchainProbe(
  cmd: string,
  args: string[],
  clock: ToolchainProbeClock,
): ProbeResult<string> {
  const probe = [cmd, ...args].join(' ');
  let output: { exitCode: number; stdout: string; stderr: string };
  try {
    output = runToolchainProbeCommand(cmd, args, clock);
  } catch (error) {
    // A cancellation or a spent budget is the caller's error, not an unreadable toolchain.
    clock.throwIfCanceled();
    if (isRequestCanceledError(error) || isRunnerPhaseBudgetExhaustedError(error)) throw error;
    return probeFailure(probe, 'probe_error', error instanceof Error ? error.message : `${error}`);
  }
  if (output.exitCode !== 0) {
    return probeFailure(
      probe,
      'nonzero_exit',
      `exit ${output.exitCode}${output.stderr.trim() ? `: ${output.stderr.trim()}` : ''}`,
    );
  }
  const value = output.stdout.trim();
  return value ? { ok: true, value } : probeFailure(probe, 'empty_output', 'no output');
}

/**
 * Retries exactly once, and only the exec layer's structured timeout: the stall
 * {@link COLD_TOOLCHAIN_PROBE_TIMEOUT_MS} names clears on the next exec of the same tool,
 * while a tool that failed on its own and said "timed out" in its output is not it.
 */
function runToolchainProbeCommand(
  cmd: string,
  args: string[],
  clock: ToolchainProbeClock,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    return attemptToolchainProbe(cmd, args, clock);
  } catch (error) {
    if (!isCommandTimeoutError(error)) throw error;
    return attemptToolchainProbe(cmd, args, clock);
  }
}

/** The one guard site: cancellation and a spent budget both throw here, before any exec. */
function attemptToolchainProbe(
  cmd: string,
  args: string[],
  clock: ToolchainProbeClock,
): { exitCode: number; stdout: string; stderr: string } {
  clock.throwIfCanceled();
  const timeoutMs = clock.attemptTimeoutMs();
  if (timeoutMs <= 0) throw runnerPhaseBudgetExhaustedError('apple_toolchain_probe');
  return runCmdSync(cmd, args, {
    allowFailure: true,
    timeoutMs,
    maxBuffer: TOOLCHAIN_PROBE_MAX_BUFFER,
  });
}

function parseXcodeVersionOutput(
  output: ProbeResult<string>,
): ProbeResult<{ version: string; buildVersion: string }> {
  if (!output.ok) {
    return output;
  }
  const version = output.value.match(/^Xcode\s+(.+)$/m)?.[1]?.trim();
  const buildVersion = output.value.match(/^Build version\s+(.+)$/m)?.[1]?.trim();
  if (!version || !buildVersion) {
    return probeFailure(
      'xcodebuild -version',
      'unparsable_output',
      `unrecognized output: ${output.value.replaceAll('\n', ' ')}`,
    );
  }
  return { ok: true, value: { version, buildVersion } };
}

function probeFailure(
  probe: string,
  reason: ToolchainProbeFailure['reason'],
  detail: string,
): { ok: false; failure: ToolchainProbeFailure } {
  const bounded =
    detail.length > TOOLCHAIN_PROBE_DETAIL_MAX_LENGTH
      ? `${detail.slice(0, TOOLCHAIN_PROBE_DETAIL_MAX_LENGTH)}…`
      : detail;
  return { ok: false, failure: { probe, reason, detail: bounded } };
}
