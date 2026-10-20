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
import fs from 'node:fs';
import path from 'node:path';
import {
  COLD_TOOLCHAIN_PROBE_TIMEOUT_MS,
  XCODE_SELECT_LINK_PATH,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
} from './apple-runner-platform.ts';
import {
  isRunnerPhaseBudgetExhaustedError,
  runnerPhaseBudgetExhaustedError,
  type RunnerPhaseBudget,
} from './runner-phase-budget.ts';

/**
 * Ceiling on the wall clock the whole toolchain fingerprint may spend, across the cache-key probe,
 * the three value probes, and their retries, when the owning phase carries no shorter budget: one
 * stalled probe, its warm retry, and the two probes still to run (#2422). The cache-key probe takes
 * at most {@link XCODE_SELECT_PROBE_TIMEOUT_MS} of it and half of what the phase has left, so a
 * stalled `xcode-select` costs a value probe that headroom and nothing more.
 */
const TOOLCHAIN_FINGERPRINT_BUDGET_MS = 45_000;

/**
 * Ceiling on one `xcode-select -p` attempt, which the cache key needs only when the host's selection
 * link cannot be read. `xcode-select -p` answers in tens of milliseconds, so this is headroom rather
 * than an expected cost, and it stays small enough that a stalled probe cannot take the cold-start
 * ceiling away from the value probes whose entry it is deciding. A selection this process cannot
 * resolve leaves the read with no dir to key on.
 */
const XCODE_SELECT_PROBE_TIMEOUT_MS = 2_000;

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
 * so the cache-key probe, the three value probes, and their retries share a single budget.
 * A phase with no deadline still gets {@link TOOLCHAIN_FINGERPRINT_BUDGET_MS} as the ceiling.
 *
 * `spawnSync` cannot be interrupted once it has started, so cancellation is observed
 * between attempts; the per-attempt cap is what bounds how long that takes.
 */
type ToolchainProbeClock = {
  /** Milliseconds the next attempt may block for; 0 once the budget is spent. */
  attemptTimeoutMs(): number;
  /**
   * Milliseconds the cache-key probe may block for. Deciding which entry to read is optional
   * work that precedes the read which answers for it, so it may spend neither more than
   * {@link XCODE_SELECT_PROBE_TIMEOUT_MS} nor more than half of what that read still needs.
   * Zero once the budget is spent, which skips the optional probe entirely.
   */
  keyProbeTimeoutMs(): number;
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
    keyProbeTimeoutMs: () =>
      Math.min(XCODE_SELECT_PROBE_TIMEOUT_MS, Math.floor(deadline.remainingMs() / 2)),
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
// that could not answer. The key carries the developer dir the read answers for
// and the identity of the bundle standing in it, so an entry is stale only until
// its own key stops describing the host's selection, which is what let a daemon
// serve the Xcode a host had left (#3300). A hit therefore renews the entry, as
// it did before: an idle entry still goes away after
// TOOLCHAIN_FINGERPRINT_TTL_MS, which also bounds how long a failure report
// can name a selection no request is using any more.
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
 * The halves of a key that answered, kept so a report reaches the same entry without resolving,
 * stating, or spawning anything: a report has no budget to spend and no deadline to answer to.
 */
type RecordedSelection = {
  developerDir: string;
  bundleIdentity: string | undefined;
};

// One clock with the fingerprints it points at, and expiry scheduled for the same reason: nothing
// renews a client dir whose reads stopped, so its record cannot outlive the entry it names.
let lazyRecordedClients: TtlMemo<string, RecordedSelection> | undefined;
function lazyRecordedClientSelections(): TtlMemo<string, RecordedSelection> | undefined {
  lazyRecordedClients ??= createTtlMemo<string, RecordedSelection>({
    ttlMs: TOOLCHAIN_FINGERPRINT_TTL_MS,
    scheduleExpiry: true,
  });
  return lazyRecordedClients;
}

/**
 * What the last default-selection read answered for, which is what a report names when the client
 * chose no `DEVELOPER_DIR`. A read that threw or could not resolve its selection leaves it alone,
 * and the entry behind it can expire, so a report that finds nothing names no Xcode.
 */
let recordedDefaultSelection: RecordedSelection | undefined;

/**
 * What each client-named selection answered for, under the exact name that client used. Kept per
 * name rather than in one slot because a daemon serves clients with different request-scoped
 * `DEVELOPER_DIR`s at once: one global record would let the last read erase what an earlier client
 * needs to report on, even though its fingerprint is still cached. It is a memo and not a map, so a
 * name drops out on the same clock as the entry it points at.
 */
function recordedClientSelection(named: string): RecordedSelection | undefined {
  return lazyRecordedClientSelections()?.get(named);
}

function rememberRecordedClientSelection(named: string, answered: RecordedSelection): void {
  lazyRecordedClientSelections()?.set(named, answered);
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
  const chosenDir = commandDeveloperDir();
  // Both sources are resolved to the dir they really name, so a client naming a symlinked Xcode and
  // a daemon reading the selection link land on one entry for one toolchain.
  const resolvedDir =
    chosenDir !== undefined
      ? (resolveRealDeveloperDir(chosenDir) ?? chosenDir)
      : resolveDefaultDeveloperDir(clock);
  // A read that cannot tell which Xcode it answers for has no entry to read or write: a shared
  // unknown key would let one host selection answer for the next, which is the fault here.
  if (resolvedDir === undefined) return requireFreshRunnerToolchainFingerprint(sdkName, clock);
  const bundleIdentity = readBundleIdentity(resolvedDir);
  // The key's two filesystem reads cannot be interrupted, so an owner that aborted while they ran
  // is answered here rather than by a memo hit: a hit must not hide a cancellation either.
  clock.throwIfCanceled();
  const cacheKey = toolchainFingerprintCacheKey(resolvedDir, bundleIdentity, sdkName);
  const fingerprint = requireMemoizedRunnerToolchainFingerprint(cacheKey, sdkName, clock);
  const answered = { developerDir: resolvedDir, bundleIdentity };
  // A report finds its entry by the key this read built, whether the read stored it or hit it, so a
  // report never has to resolve or stat anything itself.
  if (chosenDir !== undefined) rememberRecordedClientSelection(chosenDir, answered);
  else recordedDefaultSelection = answered;
  return fingerprint;
}

/**
 * A cheap identity for the toolchain bundle at `developerDir`, or undefined when it has none to
 * offer. The dir alone cannot see an update that replaces the bundle in place — an installer or App
 * Store update at `/Applications/Xcode.app` keeps the path — and a hit renews its entry, so a key
 * blind to that would keep answering with the fingerprint the update replaced for as long as the
 * daemon stays busy. The version file `xcodebuild -version` reads is the marker: replacing or
 * rewriting the bundle moves its inode or mtime, which moves the key, and the entry the old key held
 * expires once nothing renews it.
 */
function readBundleIdentity(developerDir: string): string | undefined {
  try {
    const versionFile = fs.statSync(path.join(developerDir, '..', 'version.plist'));
    return `${versionFile.ino}:${Math.trunc(versionFile.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/** This key's fingerprint, read from the memo when one answers for it and stored when it does not. */
function requireMemoizedRunnerToolchainFingerprint(
  cacheKey: string,
  sdkName: string,
  clock: ToolchainProbeClock,
): RunnerToolchainFingerprint {
  const cached = toolchainFingerprintCache().get(cacheKey);
  if (cached) {
    // A hit is an entry keyed on both this dir and the identity of the bundle standing in it, so the
    // toolchain behind the key is still the one in place and the entry renews itself. Only an entry
    // no request reads expires (#3300).
    toolchainFingerprintCache().set(cacheKey, cached);
    return cached;
  }
  const fingerprint = requireFreshRunnerToolchainFingerprint(sdkName, clock);
  toolchainFingerprintCache().set(cacheKey, fingerprint);
  return fingerprint;
}

function toolchainFingerprintCacheKey(
  developerDir: string,
  bundleIdentity: string | undefined,
  sdkName: string,
): string {
  return `${developerDir}\0${bundleIdentity ?? ''}\0${sdkName}`;
}

function requireFreshRunnerToolchainFingerprint(
  sdkName: string,
  clock: ToolchainProbeClock,
): RunnerToolchainFingerprint {
  const fingerprint = readRunnerToolchainFingerprint(sdkName, clock);
  if (!fingerprint.ok) throw unavailableToolchainError(fingerprint.failures);
  return fingerprint.value;
}

/**
 * The dir the host's default selection points at, symlinks followed. The selection link is read
 * first because the memo needs its key on every hit and not only on a miss, and spawning
 * `xcode-select` costs a few milliseconds on a warm read. A link this process cannot read falls back
 * to `xcode-select -p`, and a selection neither can name leaves the read with no key at all.
 */
function resolveDefaultDeveloperDir(clock: ToolchainProbeClock): string | undefined {
  const selectedLink = resolveRealDeveloperDir(XCODE_SELECT_LINK_PATH);
  if (selectedLink) return selectedLink;
  const reported = probeSelectedDeveloperDir(clock);
  if (reported === undefined) return undefined;
  // A selection the host names but this process cannot follow is still that host's selection, so it
  // keys on the name. Keying on nothing instead would let one host answer for the next.
  return resolveRealDeveloperDir(reported) ?? reported;
}

/**
 * The dir `candidate` really names, or undefined when nothing is there to name. `realpath` rather
 * than the link's raw target because a tool like xcodes swaps the Xcode.app bundle behind a stable
 * path: the raw target survives that swap, so a key built from it would keep answering for the Xcode
 * the host replaced.
 */
function resolveRealDeveloperDir(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;
  try {
    return fs.realpathSync(candidate.trim()) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The dir `xcode-select` currently selects, or undefined when it will not say. Best effort: a read
 * that cannot resolve its own entry spends what is left of its budget on the probes that carry the
 * answer rather than on deciding which answer to keep.
 */
function probeSelectedDeveloperDir(clock: ToolchainProbeClock): string | undefined {
  const timeoutMs = clock.keyProbeTimeoutMs();
  if (timeoutMs <= 0) return undefined;
  let selectedDir: string | undefined;
  try {
    const output = runCmdSync('xcode-select', ['-p'], {
      allowFailure: true,
      timeoutMs,
      maxBuffer: TOOLCHAIN_PROBE_MAX_BUFFER,
    });
    selectedDir = output.exitCode === 0 ? output.stdout.trim() : undefined;
  } catch {
    selectedDir = undefined;
  }
  // Also covers a request that aborted while `spawnSync` blocked: that is the caller's error, not a
  // host whose default selection cannot be read.
  clock.throwIfCanceled();
  return selectedDir || undefined;
}

/**
 * The selected Xcode's version as this process's runner cache decision memoized it, for a failure
 * report that names it; undefined when no decision has read the toolchain in the last
 * `TOOLCHAIN_FINGERPRINT_TTL_MS`. Reads nothing but the memo: a report has no budget to spend and
 * must not wait on the toolchain it describes, so it reuses the key a real read already built.
 */
export function memoizedRunnerXcodeVersion(device: DeviceInfo): string | undefined {
  const chosenDir = commandDeveloperDir();
  const answered =
    chosenDir === undefined ? recordedDefaultSelection : recordedClientSelection(chosenDir);
  if (answered === undefined) return undefined;
  return toolchainFingerprintCache().get(
    toolchainFingerprintCacheKey(
      answered.developerDir,
      answered.bundleIdentity,
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

/** The guard for a value probe: cancellation and a spent budget both throw here, before any exec. */
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
