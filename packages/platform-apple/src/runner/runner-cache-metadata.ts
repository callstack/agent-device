import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { isEnvTruthy, findProjectRoot, readVersion } from './host.ts';
import {
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDerivedBaseName,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
} from './apple-runner-platform.ts';
import {
  requireRunnerToolchainFingerprint,
  type RunnerToolchainFingerprint,
} from './runner-toolchain-probe.ts';
import type { RunnerPhaseBudget } from './runner-phase-budget.ts';
import { computeRunnerSourceFingerprint } from './runner-source.ts';

const DEFAULT_IOS_RUNNER_APP_BUNDLE_ID = 'com.callstack.agentdevice.runner';
const RUNNER_DERIVED_ROOT = path.join(os.homedir(), '.agent-device', 'apple-runner');
export const RUNNER_CACHE_METADATA_FILE = '.agent-device-runner-cache.json';
const RUNNER_CACHE_SCHEMA_VERSION = 3;
const RUNNER_CACHE_METADATA_VALUE_MAX_LENGTH = 300;

const RUNNER_SANDBOX_BUILD_ARGS = [
  '-IDEPackageSupportDisableManifestSandbox=1',
  '-IDEPackageSupportDisablePluginExecutionSandbox=1',
  'ENABLE_USER_SCRIPT_SANDBOXING=NO',
] as const;
/**
 * The isolation-scan canary compiles in every runner build, whether a build came from
 * `scripts/build-xcuitest-apple.sh` or from `ensureXctestrunArtifact`, so the metadata's
 * recorded Swift flags describe what the compiler actually received on both paths.
 */
const RUNNER_RUNTIME_SWIFT_FLAGS =
  '$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_ISOLATION_CANARY';
const RUNNER_UNIT_TEST_SWIFT_FLAGS = `${RUNNER_RUNTIME_SWIFT_FLAGS} -D AGENT_DEVICE_RUNNER_UNIT_TESTS`;

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
  runnerArchBuildSettings: string[];
  runnerSandboxBuildArgs: string[];
  artifacts?: RunnerXctestrunCacheArtifacts;
};

export type RunnerXctestrunCacheArtifacts = {
  xctestrunPath: string;
  xctestrunSize: number;
  xctestrunDigest: string;
  productPaths: string[];
  /** Paths are relative to the cache root the manifest was written under. */
  entries: RunnerCacheArtifactEntry[];
};

/**
 * One file inside a cached product bundle: its bytes hashed, its permission bits, and the
 * size that makes an equal-size rewrite with a stale mtime visible as a digest mismatch.
 */
export type RunnerCacheArtifactFileEntry = {
  path: string;
  size: number;
  mode: number;
  digest: string;
};

/** One symlink inside a cached product bundle, recorded as its raw target string. */
export type RunnerCacheArtifactSymlinkEntry = {
  path: string;
  symlink: string;
};

export type RunnerCacheArtifactEntry =
  | RunnerCacheArtifactFileEntry
  | RunnerCacheArtifactSymlinkEntry;

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
  budget?: RunnerPhaseBudget,
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
    runnerArchBuildSettings: resolveRunnerArchBuildSettings(process.env),
    runnerSandboxBuildArgs: resolveRunnerSandboxBuildArgs(),
  };
}

export function resolveRunnerDerivedPath(
  device: DeviceInfo,
  metadata: RunnerXctestrunCacheMetadata,
): string {
  const override = process.env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH?.trim();
  if (override) {
    return path.resolve(override);
  }
  const cacheKey = resolveRunnerCacheKey(metadata);
  const base = resolveRunnerDerivedBasePath(device);
  return path.join(base, cacheKey);
}

function resolveRunnerDerivedBasePath(device: DeviceInfo): string {
  return path.join(RUNNER_DERIVED_ROOT, 'derived', resolveRunnerDerivedBaseName(device));
}

export function resolveRunnerCacheKey(metadata: RunnerXctestrunCacheMetadata): string {
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

/**
 * The architecture an explicit `AGENT_DEVICE_XCUITEST_ARCHS` pins. A generic simulator
 * destination leaves the active arch undefined and Xcode picks one per version, so the
 * override changes the bytes on disk and must reach both the `xcodebuild` arguments and the
 * cache identity from this one resolver.
 */
export function resolveRunnerArchBuildSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  const archs = env.AGENT_DEVICE_XCUITEST_ARCHS?.trim();
  return archs ? [`ARCHS=${archs}`] : [];
}

/**
 * Pins the build roots to the default layout under `derived`. `-derivedDataPath` alone does not:
 * a custom or legacy build location in the user's Xcode settings still redirects products and
 * intermediates, so the `.xctestrun` would land outside the cache directory.
 */
export function resolveRunnerBuildLocationSettings(derived: string): string[] {
  const intermediates = path.join(derived, 'Build', 'Intermediates.noindex');
  return [
    `SYMROOT=${path.join(derived, 'Build', 'Products')}`,
    `OBJROOT=${intermediates}`,
    `SHARED_PRECOMPS_DIR=${path.join(intermediates, 'PrecompiledHeaders')}`,
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

const BUILD_SETTINGS_HEADER = /^\s*Build settings from command line:\s*$/;
const BUILD_SETTING_LINE = /^\s+([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/;
const RECORDED_BUILD_SETTING = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const COMMAND_LINE_INVOCATION_HEADER = /^\s*Command line invocation:\s*$/;

export type RunnerBuildSettingEvidence = {
  key: string;
  expected: string;
  actual: string;
};

/**
 * What one build log says it was handed: the settings block `xcodebuild` echoed, and the
 * invocation line that carries every argument, including the ones that are not build settings.
 * Null when the log holds no settings block at all.
 */
type RunnerBuildLogRecipe = {
  settings: Map<string, string>;
  invocationLine: string;
};

function readRunnerBuildLogRecipe(logPath: string): RunnerBuildLogRecipe | null {
  let contents: string;
  try {
    contents = fs.readFileSync(logPath, 'utf8');
  } catch {
    return null;
  }
  const lines = contents.split('\n');
  const settings = new Map<string, string>();
  let inBlock = false;
  let invocationLine = '';
  for (const [index, line] of lines.entries()) {
    if (COMMAND_LINE_INVOCATION_HEADER.test(line)) {
      invocationLine = lines[index + 1] ?? '';
      continue;
    }
    if (BUILD_SETTINGS_HEADER.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    const setting = BUILD_SETTING_LINE.exec(line);
    if (!setting) break;
    settings.set(setting[1]!, setting[2]!.trimEnd());
  }
  return inBlock ? { settings, invocationLine } : null;
}

/** Every argument the cache identity records as a recipe, in the `xcodebuild` spelling. */
function recordedRunnerBuildArguments(metadata: RunnerXctestrunCacheMetadata): string[] {
  return [
    ...metadata.runnerBundleBuildSettings,
    ...metadata.runnerSigningBuildSettings,
    ...metadata.runnerPerformanceBuildSettings,
    ...metadata.runnerArchBuildSettings,
    ...metadata.runnerSandboxBuildArgs,
  ];
}

function recordedRunnerBuildSettings(
  metadata: RunnerXctestrunCacheMetadata,
): Record<string, string> {
  const recorded: Record<string, string> = {};
  for (const arg of recordedRunnerBuildArguments(metadata)) {
    const setting = RECORDED_BUILD_SETTING.exec(arg);
    if (setting) {
      recorded[setting[1]!] = setting[2]!;
    }
  }
  return recorded;
}

/**
 * Recorded arguments `xcodebuild` echoes on the invocation line rather than in its settings block,
 * which is where its whole recipe shows: `-I` user-default flags such as the package-sandbox
 * disables. Without this the settings diff would call a recipe complete while ignoring them.
 */
function diffRunnerInvocationFlagsAgainstBuildLog(
  metadata: RunnerXctestrunCacheMetadata,
  invocationLine: string,
): RunnerBuildSettingEvidence[] {
  return recordedRunnerBuildArguments(metadata)
    .filter((arg) => !RECORDED_BUILD_SETTING.test(arg))
    .filter((arg) => !invocationLine.includes(arg))
    .map((arg) => ({
      key: '(invocation flag)',
      expected: arg,
      actual: 'absent from the "Command line invocation:" line',
    }));
}

/**
 * The recorded settings a build log shows `xcodebuild` did not receive exactly as recorded. An
 * empty recorded value matches an absent report, which is how `CODE_SIGN_IDENTITY=` arrives.
 */
function diffRunnerBuildSettingsAgainstBuildLog(
  metadata: RunnerXctestrunCacheMetadata,
  logPath: string,
): RunnerBuildSettingEvidence[] {
  const reported = readRunnerBuildLogRecipe(logPath);
  if (!reported) {
    return [
      {
        key: '(build log)',
        expected: 'a "Build settings from command line:" block',
        actual: 'missing or unreadable log',
      },
    ];
  }
  const settingDifferences = Object.entries(recordedRunnerBuildSettings(metadata))
    .filter(([key, expected]) => {
      const actual = reported.settings.get(key);
      return actual === undefined ? expected !== '' : actual !== expected;
    })
    .map(([key, expected]) => ({
      key,
      expected,
      actual: reported.settings.get(key) ?? '(absent)',
    }));
  return [
    ...settingDifferences,
    ...diffRunnerInvocationFlagsAgainstBuildLog(metadata, reported.invocationLine),
  ];
}

/**
 * Fails when a build log shows a recipe other than the one `metadata` records — a setting whose
 * value differs or went missing, or a recorded flag absent from the invocation — so a caller that
 * drifted from this identity cannot have its products certified under it.
 */
export function requireRunnerBuildSettingsMatchBuildLog(
  metadata: RunnerXctestrunCacheMetadata,
  logPath: string,
): void {
  const differences = diffRunnerBuildSettingsAgainstBuildLog(metadata, logPath);
  if (differences.length === 0) {
    return;
  }
  throw new AppError(
    'COMMAND_FAILED',
    'The Apple runner build did not use the settings its cache identity records',
    {
      reason: 'runner_build_settings_mismatch',
      buildLogPath: logPath,
      differences,
      hint: 'Align the build invocation with the runner cache identity resolvers, or rebuild without the cache.',
    },
  );
}
