import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import {
  coldToolchainProbeTimeoutMs,
  createTtlMemo,
  Deadline,
  isCommandTimeoutError,
  isEnvTruthy,
  findProjectRoot,
  readVersion,
  runCmdSync,
  type TtlMemo,
} from './host.ts';
import {
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDerivedBaseName,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
} from './apple-runner-platform.ts';
import { computeRunnerSourceFingerprint } from './runner-source.ts';

const DEFAULT_IOS_RUNNER_APP_BUNDLE_ID = 'com.callstack.agentdevice.runner';
const RUNNER_DERIVED_ROOT = path.join(os.homedir(), '.agent-device', 'apple-runner');
export const RUNNER_CACHE_METADATA_FILE = '.agent-device-runner-cache.json';
const RUNNER_CACHE_SCHEMA_VERSION = 2;
const RUNNER_CACHE_METADATA_VALUE_MAX_LENGTH = 300;

/**
 * Ceiling on the wall clock the whole toolchain fingerprint may spend, across
 * all three probes and their retries, when the owning phase carries no shorter
 * budget. Sized for the one cold-start stall the retry exists for -- a single
 * stalled probe (up to the host's `coldToolchainProbeTimeoutMs()`) plus its
 * now-warm retry and the two remaining probes -- not for three independently
 * stalling tools, which is why the per-call timeout alone is not the bound
 * (#2422).
 */
const TOOLCHAIN_FINGERPRINT_BUDGET_MS = 45_000;
const TOOLCHAIN_PROBE_MAX_BUFFER = 128 * 1024;
const TOOLCHAIN_PROBE_DETAIL_MAX_LENGTH = 200;
const TOOLCHAIN_PROBE_HINT =
  'The Apple runner cache is keyed on the toolchain version, so a cache decision cannot be made without it. Retry once the host is less loaded, or check `xcode-select -p` and `xcodebuild -version`.';
const RUNNER_SANDBOX_BUILD_ARGS = [
  '-IDEPackageSupportDisableManifestSandbox=1',
  '-IDEPackageSupportDisablePluginExecutionSandbox=1',
  'ENABLE_USER_SCRIPT_SANDBOXING=NO',
] as const;
const RUNNER_RUNTIME_SWIFT_FLAGS = '$(inherited) -disable-sandbox';
const RUNNER_UNIT_TEST_SWIFT_FLAGS =
  '$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS';

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

/**
 * The one clock a runner phase spends, for a step whose budget is `timeoutMs`;
 * `undefined` for a caller that carries no budget at all (background and
 * preflight surfaces). The cache decision's blocking toolchain probes and the
 * step the phase exists for (an `xcodebuild` build, a runner startup) both read
 * it, so what the probes spend is time the step no longer has. Create it once
 * per phase and read the rest with {@link requireRunnerPhaseRemainingMs}; a
 * step that hands the probes a timeout and then hands itself the same number
 * again spends the phase's budget twice (#2422).
 */
export function createRunnerPhaseDeadline(timeoutMs: number | undefined): Deadline | undefined {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return undefined;
  return Deadline.fromTimeoutMs(Math.max(0, timeoutMs));
}

/**
 * What the phase has left for its next step, or `fallbackTimeoutMs` when it
 * carries no deadline. Throws instead of returning zero: a step reached with
 * nothing left must fail before it spawns anything, not start a process it
 * would have to kill immediately.
 */
export function requireRunnerPhaseRemainingMs(
  deadline: Deadline | undefined,
  fallbackTimeoutMs: number | undefined,
  phase: string,
): number | undefined {
  if (!deadline) return fallbackTimeoutMs;
  const remainingMs = Math.floor(deadline.remainingMs());
  if (remainingMs <= 0) throw runnerPhaseBudgetExhaustedError(phase);
  return remainingMs;
}

/**
 * The one error a runner phase raises when a step is reached with nothing left
 * to spend, whether that step is an `xcodebuild` build, a runner startup, or a
 * toolchain probe. It says the budget ran out, not that the thing it would have
 * run is broken.
 */
function runnerPhaseBudgetExhaustedError(phase: string): AppError {
  return new AppError('COMMAND_FAILED', 'The Apple runner budget ran out before this step began', {
    phase,
    reason: 'runner_phase_budget_exhausted',
    retriable: true,
  });
}

/**
 * What the phase that wants a runner cache decision has left to spend on it.
 * The decision blocks the calling request on up to three synchronous `spawnSync`
 * probes, so the phase's own deadline and cancellation must reach them: an
 * exhausted budget fails the decision instead of starting another 30 second
 * probe, and a canceled request surfaces the cancellation rather than
 * retrying (#2422). A caller with neither still gets
 * {@link TOOLCHAIN_FINGERPRINT_BUDGET_MS} as the ceiling.
 *
 * `spawnSync` cannot be interrupted once it has started, so cancellation is
 * observed between attempts; the per-attempt cap is what bounds how long that
 * takes.
 */
export type RunnerCacheProbeBudget = {
  /** The owning phase's clock, shared with whatever the phase does next. */
  deadline?: Deadline;
  /** The owning request's cancellation signal, if it carries one. */
  signal?: AbortSignal;
};

/**
 * The remaining-time and cancellation view the probes consult. One is created
 * per fingerprint read, so the three probes and their retries share -- and
 * together cannot exceed -- a single budget.
 */
type ToolchainProbeClock = {
  /** Milliseconds the next attempt may block for; 0 once the budget is spent. */
  attemptTimeoutMs(): number;
  /** Throws the owning request's cancellation error once it has aborted. */
  throwIfCanceled(): void;
};

function createToolchainProbeClock(
  budget: RunnerCacheProbeBudget | undefined,
): ToolchainProbeClock {
  const phaseDeadline = budget?.deadline;
  // The fingerprint's own deadline, opened at whichever of the two ceilings is
  // nearer: the phase's remainder, or the fingerprint budget for a caller with
  // no phase clock (or a generous one). Both are wall-clock, so the step after
  // the probes still sees the time they spent.
  const deadline = Deadline.fromTimeoutMs(
    Math.min(
      TOOLCHAIN_FINGERPRINT_BUDGET_MS,
      phaseDeadline ? phaseDeadline.remainingMs() : Number.POSITIVE_INFINITY,
    ),
  );
  return {
    attemptTimeoutMs: () =>
      Math.min(coldToolchainProbeTimeoutMs(), Math.floor(deadline.remainingMs())),
    throwIfCanceled: () => {
      if (budget?.signal?.aborted) {
        throw createRequestCanceledError({ phase: 'apple_toolchain_probe' });
      }
    },
  };
}

type ProbeResult<Value> =
  | { ok: true; value: Value }
  | { ok: false; failure: ToolchainProbeFailure };

export type RunnerXctestrunCacheMetadata = RunnerToolchainFingerprint & {
  schemaVersion: number;
  packageVersion: string;
  runnerSourceFingerprint: string;
  platformName: string;
  deviceKind: DeviceInfo['kind'];
  target: NonNullable<DeviceInfo['target']>;
  buildDestinationFamily: string;
  runnerBundleBuildSettings: string[];
  runnerSigningBuildSettings: string[];
  runnerPerformanceBuildSettings: string[];
  runnerSandboxBuildArgs: string[];
  artifacts?: RunnerXctestrunCacheArtifacts;
};

export type RunnerXctestrunCacheArtifacts = {
  xctestrunPath: string;
  xctestrunMtimeMs: number;
  xctestrunSize: number;
  productPaths: RunnerXctestrunCacheProductArtifact[];
};

export type RunnerXctestrunCacheProductArtifact = {
  path: string;
  mtimeMs: number;
  size: number;
};

function normalizeBundleId(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function resolveRunnerAppBundleId(env: NodeJS.ProcessEnv = process.env): string {
  const configured =
    normalizeBundleId(env.AGENT_DEVICE_IOS_BUNDLE_ID) ||
    normalizeBundleId(env.AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID);
  return configured || DEFAULT_IOS_RUNNER_APP_BUNDLE_ID;
}

function resolveRunnerTestBundleId(env: NodeJS.ProcessEnv = process.env): string {
  const configured = normalizeBundleId(env.AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID);
  if (configured) {
    return configured;
  }
  return `${resolveRunnerAppBundleId(env)}.uitests`;
}

function resolveRunnerContainerBundleIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const appBundleId = resolveRunnerAppBundleId(env);
  const testBundleId = resolveRunnerTestBundleId(env);
  return Array.from(
    new Set(
      [
        normalizeBundleId(env.AGENT_DEVICE_IOS_RUNNER_CONTAINER_BUNDLE_ID),
        `${testBundleId}.xctrunner`,
        appBundleId,
      ].filter((id) => id.length > 0),
    ),
  );
}

export const IOS_RUNNER_CONTAINER_BUNDLE_IDS: string[] = resolveRunnerContainerBundleIds(
  process.env,
);

export function resolveExpectedRunnerCacheMetadata(
  device: DeviceInfo,
  projectRoot: string = findProjectRoot(),
  budget?: RunnerCacheProbeBudget,
): RunnerXctestrunCacheMetadata {
  const platformName = resolveRunnerPlatformName(device);
  return {
    schemaVersion: RUNNER_CACHE_SCHEMA_VERSION,
    packageVersion: readVersion(projectRoot),
    runnerSourceFingerprint: computeRunnerSourceFingerprint(projectRoot),
    ...requireRunnerToolchainFingerprint(resolveRunnerSdkName(platformName, device.kind), budget),
    platformName,
    deviceKind: device.kind,
    target: device.target ?? 'mobile',
    buildDestinationFamily: resolveRunnerBuildDestinationFamily(device),
    runnerBundleBuildSettings: resolveRunnerBundleBuildSettings(process.env),
    runnerSigningBuildSettings: resolveRunnerSigningBuildSettings(
      process.env,
      device.kind === 'device',
      device,
    ),
    runnerPerformanceBuildSettings: resolveRunnerPerformanceBuildSettings(),
    runnerSandboxBuildArgs: resolveRunnerSandboxBuildArgs(),
  };
}

// Lazy: createTtlMemo is a host capability, and module evaluation happens
// before the composition root binds the host. Only a complete, parsed
// fingerprint is ever memoized, so nothing unavailable can outlive the probe
// that could not answer.
let lazyToolchainFingerprintCache: TtlMemo<string, RunnerToolchainFingerprint> | undefined;
function toolchainFingerprintCache(): TtlMemo<string, RunnerToolchainFingerprint> {
  lazyToolchainFingerprintCache ??= createTtlMemo<string, RunnerToolchainFingerprint>();
  return lazyToolchainFingerprintCache;
}

/**
 * The toolchain half of the cache key, or a failure. A probe that timed out or
 * could not be read has no value to compare or persist, and the same
 * fingerprint also names the derived-data directory, so an unreadable
 * toolchain fails the cache decision instead of standing in for one.
 */
function requireRunnerToolchainFingerprint(
  sdkName: string,
  budget: RunnerCacheProbeBudget | undefined,
): RunnerToolchainFingerprint {
  const cached = toolchainFingerprintCache().get(sdkName);
  if (cached) return cached;
  const fingerprint = readRunnerToolchainFingerprint(sdkName, createToolchainProbeClock(budget));
  if (!fingerprint.ok) throw unavailableToolchainError(fingerprint.failures);
  toolchainFingerprintCache().set(sdkName, fingerprint.value);
  return fingerprint.value;
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
  // Both checks are outside the try, and both throw rather than becoming a
  // probe failure: a canceled request and a spent budget are the caller's own
  // errors to see. Reporting an unreadable toolchain instead would blame the
  // toolchain for a probe that never ran.
  clock.throwIfCanceled();
  if (clock.attemptTimeoutMs() <= 0) {
    throw runnerPhaseBudgetExhaustedError('apple_toolchain_probe');
  }
  let output: { exitCode: number; stdout: string; stderr: string };
  try {
    output = runToolchainProbeCommand(cmd, args, clock);
  } catch (error) {
    clock.throwIfCanceled();
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
 * Runs one toolchain probe, retrying exactly once if the attempt timed out and
 * the shared budget still has room. Apple's syspolicyd signature scan blocks
 * the first `xcodebuild`/`xcrun` exec after a fresh host boots (see
 * `COLD_TOOLCHAIN_PROBE_TIMEOUT_MS` in `@agent-device/host-kit/command`, which
 * reaches this file through the host port); the immediate next exec of the same
 * tool is instant, so the retry recovers without widening the per-call budget. Only the
 * exec layer's structured timeout is retried -- a tool that failed on its own
 * and merely said "timed out" in its output is not this stall.
 */
function runToolchainProbeCommand(
  cmd: string,
  args: string[],
  clock: ToolchainProbeClock,
): { exitCode: number; stdout: string; stderr: string } {
  try {
    return execToolchainProbeCommand(cmd, args, clock);
  } catch (error) {
    if (!isCommandTimeoutError(error)) throw error;
    clock.throwIfCanceled();
    if (clock.attemptTimeoutMs() <= 0) throw error;
    return execToolchainProbeCommand(cmd, args, clock);
  }
}

function execToolchainProbeCommand(
  cmd: string,
  args: string[],
  clock: ToolchainProbeClock,
): { exitCode: number; stdout: string; stderr: string } {
  return runCmdSync(cmd, args, {
    allowFailure: true,
    timeoutMs: clock.attemptTimeoutMs(),
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

export function resolveRunnerDerivedPath(
  device: DeviceInfo,
  metadata: RunnerXctestrunCacheMetadata,
): string {
  const override = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  const cacheKey = resolveRunnerDerivedCacheKey(metadata);
  const base = resolveRunnerDerivedBasePath(device);
  return path.join(base, cacheKey);
}

function resolveRunnerDerivedBasePath(device: DeviceInfo): string {
  return path.join(RUNNER_DERIVED_ROOT, 'derived', resolveRunnerDerivedBaseName(device));
}

function resolveRunnerDerivedCacheKey(metadata: RunnerXctestrunCacheMetadata): string {
  const hash = crypto
    .createHash('sha256')
    .update(stableJsonStringify(comparableRunnerCacheMetadata(metadata)))
    .digest('hex');
  return `cache-${hash.slice(0, 16)}`;
}

export function comparableRunnerCacheMetadata(
  metadata: RunnerXctestrunCacheMetadata,
): Omit<RunnerXctestrunCacheMetadata, 'artifacts' | 'packageVersion'> {
  const { artifacts: _artifacts, packageVersion: _packageVersion, ...comparable } = metadata;
  return comparable;
}

export type RunnerCacheMetadataDifference = {
  key: string;
  expected: string;
  actual: string;
};

export function diffComparableRunnerCacheMetadata(
  expected: RunnerXctestrunCacheMetadata,
  actual: RunnerXctestrunCacheMetadata,
): RunnerCacheMetadataDifference[] {
  const expectedComparable: Record<string, unknown> = comparableRunnerCacheMetadata(expected);
  const actualComparable: Record<string, unknown> = comparableRunnerCacheMetadata(actual);
  return [...new Set([...Object.keys(expectedComparable), ...Object.keys(actualComparable)])]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((key) => {
      const expectedValue = renderRunnerCacheMetadataValue(expectedComparable[key]);
      const actualValue = renderRunnerCacheMetadataValue(actualComparable[key]);
      return expectedValue === actualValue
        ? []
        : [
            {
              key,
              expected: elideRunnerCacheMetadataValue(expectedValue),
              actual: elideRunnerCacheMetadataValue(actualValue),
            },
          ];
    });
}

function renderRunnerCacheMetadataValue(value: unknown): string {
  return value === undefined ? '(absent)' : stableJsonStringify(value);
}

// Elides the middle: build-setting lists differ in their last entry as often as
// their first, and a head-only cut would render both sides identically.
function elideRunnerCacheMetadataValue(value: string): string {
  if (value.length <= RUNNER_CACHE_METADATA_VALUE_MAX_LENGTH) {
    return value;
  }
  const half = Math.floor((RUNNER_CACHE_METADATA_VALUE_MAX_LENGTH - 1) / 2);
  return `${value.slice(0, half)}…${value.slice(-half)}`;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeys(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonKeys(item)]),
  );
}

export function resolveRunnerMaxConcurrentDestinationsFlag(device: DeviceInfo): string {
  if (isMacOs(device)) {
    return '-maximum-concurrent-test-device-destinations';
  }
  return device.kind === 'device'
    ? '-maximum-concurrent-test-device-destinations'
    : '-maximum-concurrent-test-simulator-destinations';
}

export function resolveRunnerSigningBuildSettings(
  env: NodeJS.ProcessEnv = process.env,
  forDevice = false,
  device: Pick<DeviceInfo, 'platform' | 'appleOs'> = { platform: 'apple' },
): string[] {
  if (isMacOs(device)) {
    return [
      'CODE_SIGNING_ALLOWED=NO',
      'CODE_SIGNING_REQUIRED=NO',
      'CODE_SIGN_IDENTITY=',
      'DEVELOPMENT_TEAM=',
    ];
  }
  if (!forDevice) {
    return [];
  }
  const teamId = env.AGENT_DEVICE_IOS_TEAM_ID?.trim() || '';
  const configuredIdentity = env.AGENT_DEVICE_IOS_SIGNING_IDENTITY?.trim() || '';
  const profile = env.AGENT_DEVICE_IOS_PROVISIONING_PROFILE?.trim() || '';
  const args = [`CODE_SIGN_STYLE=${profile ? 'Manual' : 'Automatic'}`];
  if (teamId) {
    args.push(`DEVELOPMENT_TEAM=${teamId}`);
  }
  if (configuredIdentity) {
    args.push(`CODE_SIGN_IDENTITY=${configuredIdentity}`);
  }
  if (profile) args.push(`PROVISIONING_PROFILE_SPECIFIER=${profile}`);
  return args;
}

export function resolveRunnerBundleBuildSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const appBundleId = resolveRunnerAppBundleId(env);
  const testBundleId = resolveRunnerTestBundleId(env);
  return [
    `AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID=${appBundleId}`,
    `AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID=${testBundleId}`,
  ];
}

export function resolveRunnerPerformanceBuildSettings(): string[] {
  return [
    'COMPILER_INDEX_STORE_ENABLE=NO',
    'ENABLE_CODE_COVERAGE=NO',
    'ONLY_ACTIVE_ARCH=YES',
    'ENABLE_PREVIEWS=NO',
    'ENABLE_DEBUG_DYLIB=NO',
  ];
}

export function resolveRunnerSandboxBuildArgs(): string[] {
  return [
    ...RUNNER_SANDBOX_BUILD_ARGS,
    `OTHER_SWIFT_FLAGS=${resolveRunnerSwiftFlags(process.env)}`,
  ];
}

function resolveRunnerSwiftFlags(env: NodeJS.ProcessEnv): string {
  return isEnvTruthy(env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS)
    ? RUNNER_UNIT_TEST_SWIFT_FLAGS
    : RUNNER_RUNTIME_SWIFT_FLAGS;
}
