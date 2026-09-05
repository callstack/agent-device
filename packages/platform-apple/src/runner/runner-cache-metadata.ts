import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  createTtlMemo,
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
const TOOLCHAIN_PROBE_TIMEOUT_MS = 5_000;
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
): RunnerXctestrunCacheMetadata {
  const platformName = resolveRunnerPlatformName(device);
  return {
    schemaVersion: RUNNER_CACHE_SCHEMA_VERSION,
    packageVersion: readVersion(projectRoot),
    runnerSourceFingerprint: computeRunnerSourceFingerprint(projectRoot),
    ...requireRunnerToolchainFingerprint(resolveRunnerSdkName(platformName, device.kind)),
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
// before the composition root binds the host.
let lazyToolchainProbeCache: TtlMemo<string, string> | undefined;
function toolchainProbeCache(): TtlMemo<string, string> {
  lazyToolchainProbeCache ??= createTtlMemo<string, string>();
  return lazyToolchainProbeCache;
}

/**
 * The toolchain half of the cache key, or a failure. A probe that timed out or
 * could not be read has no value to compare or persist, and the same
 * fingerprint also names the derived-data directory, so an unreadable
 * toolchain fails the cache decision instead of standing in for one.
 */
function requireRunnerToolchainFingerprint(sdkName: string): RunnerToolchainFingerprint {
  const xcode = parseXcodeVersionOutput(runToolchainProbe('xcodebuild', ['-version']));
  const sdkVersion = runToolchainProbe('xcrun', ['--sdk', sdkName, '--show-sdk-version']);
  const sdkBuildVersion = runToolchainProbe('xcrun', [
    '--sdk',
    sdkName,
    '--show-sdk-build-version',
  ]);
  if (!xcode.ok || !sdkVersion.ok || !sdkBuildVersion.ok) {
    throw unavailableToolchainError(
      [xcode, sdkVersion, sdkBuildVersion].flatMap((probe) => (probe.ok ? [] : [probe.failure])),
    );
  }
  return {
    xcodeVersion: xcode.value.version,
    xcodeBuildVersion: xcode.value.buildVersion,
    sdkName,
    sdkVersion: sdkVersion.value,
    sdkBuildVersion: sdkBuildVersion.value,
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

function runToolchainProbe(cmd: string, args: string[]): ProbeResult<string> {
  const cacheKey = JSON.stringify([cmd, args]);
  const cached = toolchainProbeCache().get(cacheKey);
  if (cached !== undefined) {
    return { ok: true, value: cached };
  }
  const result = readToolchainProbeOutput([cmd, ...args].join(' '), cmd, args);
  if (result.ok) {
    toolchainProbeCache().set(cacheKey, result.value);
  }
  return result;
}

function readToolchainProbeOutput(probe: string, cmd: string, args: string[]): ProbeResult<string> {
  let output: { exitCode: number; stdout: string; stderr: string };
  try {
    output = runCmdSync(cmd, args, {
      allowFailure: true,
      timeoutMs: TOOLCHAIN_PROBE_TIMEOUT_MS,
      maxBuffer: TOOLCHAIN_PROBE_MAX_BUFFER,
    });
  } catch (error) {
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
