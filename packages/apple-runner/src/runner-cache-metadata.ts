import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { hostEnvironment, isEnvTruthy, findProjectRoot, readVersion } from './host.ts';
import {
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDerivedBaseName,
  resolveRunnerDerivedOverride,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
} from './apple-runner-platform.ts';
import {
  requireRunnerToolchainFingerprint,
  type RunnerToolchainFingerprint,
} from './runner-toolchain-identity.ts';
import type { RunnerPhaseBudget } from './runner-phase-budget.ts';
import { computeRunnerSourceFingerprint } from './runner-source.ts';

const RUNNER_BUILD_SETTINGS_REASONS = {
  // The runner build used settings other than those its cache identity records.
  buildSettingsMismatch: { reason: 'runner_build_settings_mismatch' },
} as const satisfies ReasonTable<'apple runner'>;

const RUNNER_SIGNING_AUTH_REASONS = {
  // The App Store Connect API key variables are set only in part; xcodebuild takes all three or none.
  signingAuthKeyIncomplete: { reason: 'signing_auth_key_incomplete' },
  // The App Store Connect API key path names no readable regular file; the build refuses before it starts.
  signingAuthKeyInvalidPath: { reason: 'signing_auth_key_invalid_path' },
} as const satisfies ReasonTable<'apple runner'>;

/**
 * The build-time ASC API key environment family, in argv order. The build passes the trio as
 * `xcodebuild` arguments and omits the same names from the child environment, so the credentials
 * travel by argument only.
 */
export const RUNNER_SIGNING_AUTH_ENV_NAMES = [
  'AGENT_DEVICE_IOS_AUTH_KEY_PATH',
  'AGENT_DEVICE_IOS_AUTH_KEY_ID',
  'AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID',
] as const;

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
/**
 * The Objective-C half of the unit-test build setting. The host app's fixture screens live in
 * `AgentDeviceRunnerAppFixtures.m`, which compiles only under this define, so the flag decides
 * both the Swift `#if AGENT_DEVICE_RUNNER_UNIT_TESTS` blocks and the fixture host the UnitTests/
 * suites launch. `OTHER_CFLAGS` rather than `GCC_PREPROCESSOR_DEFINITIONS`: a command-line value
 * for the latter replaces the configuration's list instead of extending it.
 */
const RUNNER_UNIT_TEST_C_FLAGS = '-D AGENT_DEVICE_RUNNER_UNIT_TESTS';
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

export function resolveRunnerAppBundleId(env: NodeJS.ProcessEnv = hostEnvironment().env): string {
  const configured =
    normalizeBundleId(env.AGENT_DEVICE_IOS_BUNDLE_ID) ||
    normalizeBundleId(env.AGENT_DEVICE_IOS_RUNNER_APP_BUNDLE_ID);
  return configured || DEFAULT_IOS_RUNNER_APP_BUNDLE_ID;
}

function resolveRunnerTestBundleId(env: NodeJS.ProcessEnv = hostEnvironment().env): string {
  const configured = normalizeBundleId(env.AGENT_DEVICE_IOS_RUNNER_TEST_BUNDLE_ID);
  if (configured) {
    return configured;
  }
  return `${resolveRunnerAppBundleId(env)}.uitests`;
}

export function resolveRunnerContainerBundleIds(env: NodeJS.ProcessEnv): string[] {
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

export function resolveExpectedRunnerCacheMetadata(
  device: DeviceInfo,
  projectRoot: string = findProjectRoot(),
  budget?: RunnerPhaseBudget,
): RunnerXctestrunCacheMetadata {
  const platformName = resolveRunnerPlatformName(device);
  const { env } = hostEnvironment();
  return {
    schemaVersion: RUNNER_CACHE_SCHEMA_VERSION,
    packageVersion: readVersion(projectRoot),
    runnerSourceFingerprint: computeRunnerSourceFingerprint(projectRoot),
    ...requireRunnerToolchainFingerprint(
      resolveRunnerSdkName(platformName, device.kind),
      budget?.signal,
    ),
    platformName,
    deviceKind: device.kind,
    target: device.target ?? 'mobile',
    buildDestinationFamily: resolveRunnerBuildDestinationFamily(device),
    runnerBundleBuildSettings: resolveRunnerBundleBuildSettings(env),
    runnerSigningBuildSettings: resolveRunnerSigningBuildSettings(
      env,
      device.kind === 'device',
      device,
    ),
    runnerPerformanceBuildSettings: resolveRunnerPerformanceBuildSettings(),
    runnerArchBuildSettings: resolveRunnerArchBuildSettings(env),
    runnerSandboxBuildArgs: resolveRunnerSandboxBuildArgs(env),
  };
}

export function resolveRunnerDerivedPath(
  device: DeviceInfo,
  metadata: RunnerXctestrunCacheMetadata,
): string {
  return (
    resolveRunnerDerivedOverride(hostEnvironment().env) ??
    resolveRunnerKeyedDerivedPath(device, metadata)
  );
}

export function resolveRunnerKeyedDerivedPath(
  device: DeviceInfo,
  metadata: RunnerXctestrunCacheMetadata,
): string {
  return path.join(resolveRunnerDerivedBasePath(device), resolveRunnerCacheKey(metadata));
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
  env: NodeJS.ProcessEnv = hostEnvironment().env,
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

/**
 * One typed configuration refusal for the key path: the error names the variable, never the value
 * and never the raw filesystem error, so neither reaches a log or an error payload.
 */
function invalidAuthKeyPathError(envName: string): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The App Store Connect API key path is not a readable key file',
    {
      reason: RUNNER_SIGNING_AUTH_REASONS.signingAuthKeyInvalidPath.reason,
      envName,
      hint: `Set ${envName} to the absolute path of a readable App Store Connect API key .p8 file.`,
    },
  );
}

/** True only for a readable regular file; NUL bytes and every other stat failure answer false. */
function isReadableRegularFilePath(candidate: string): boolean {
  if (candidate.length === 0 || candidate.includes('\0')) return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The App Store Connect API key that lets `-allowProvisioningUpdates` resolve automatic signing on
 * a host with no interactive Xcode sign-in, read beside the signing settings it complements. The
 * whole trio rides the command, a partial trio refuses the build here — before `xcodebuild` runs,
 * so the failure carries this typed reason instead of the classifier's unclassified one — and no
 * trio leaves the invocation byte-identical.
 */
export function resolveRunnerProvisioningAuthArgs(
  env: NodeJS.ProcessEnv = hostEnvironment().env,
  forDevice = false,
  device: Pick<DeviceInfo, 'platform' | 'appleOs'> = { platform: 'apple' },
): string[] {
  if (isMacOs(device) || !forDevice) {
    return [];
  }
  const values = [
    {
      name: 'AGENT_DEVICE_IOS_AUTH_KEY_PATH',
      value: env.AGENT_DEVICE_IOS_AUTH_KEY_PATH?.trim() || '',
    },
    { name: 'AGENT_DEVICE_IOS_AUTH_KEY_ID', value: env.AGENT_DEVICE_IOS_AUTH_KEY_ID?.trim() || '' },
    {
      name: 'AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID',
      value: env.AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID?.trim() || '',
    },
  ];
  const missing = values.filter((entry) => entry.value.length === 0).map((entry) => entry.name);
  if (missing.length === values.length) {
    return [];
  }
  if (missing.length > 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'The App Store Connect API key environment variables are only partially set',
      {
        reason: RUNNER_SIGNING_AUTH_REASONS.signingAuthKeyIncomplete.reason,
        missingEnv: missing,
        hint: 'Set all three of AGENT_DEVICE_IOS_AUTH_KEY_PATH, AGENT_DEVICE_IOS_AUTH_KEY_ID and AGENT_DEVICE_IOS_AUTH_KEY_ISSUER_ID, or unset the rest.',
      },
    );
  }
  const [keyPath, keyId, issuerId] = values.map((entry) => entry.value);
  // The path is validated before the argv is built: a missing file, a directory, or a NUL-bearing
  // value refuses here with the typed config error instead of reaching xcodebuild, whose spawn
  // failure would carry the value into the error details.
  if (!isReadableRegularFilePath(keyPath!)) {
    throw invalidAuthKeyPathError('AGENT_DEVICE_IOS_AUTH_KEY_PATH');
  }
  return [
    '-authenticationKeyPath',
    keyPath!,
    '-authenticationKeyID',
    keyId!,
    '-authenticationKeyIssuerID',
    issuerId!,
  ];
}

export function resolveRunnerBundleBuildSettings(
  env: NodeJS.ProcessEnv = hostEnvironment().env,
): string[] {
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
export function resolveRunnerArchBuildSettings(
  env: NodeJS.ProcessEnv = hostEnvironment().env,
): string[] {
  const archs = env.AGENT_DEVICE_XCUITEST_ARCHS?.trim();
  return archs ? [`ARCHS=${archs}`] : [];
}

/**
 * Pins the build roots under `derived`, with the products in `productsDir`. `-derivedDataPath`
 * alone does not: a custom or legacy build location in the user's Xcode settings still redirects
 * products and intermediates, so the `.xctestrun` would land outside the cache directory.
 */
export function resolveRunnerBuildLocationSettings(derived: string, productsDir: string): string[] {
  const intermediates = path.join(derived, 'Build', 'Intermediates.noindex');
  return [
    `SYMROOT=${productsDir}`,
    `OBJROOT=${intermediates}`,
    `SHARED_PRECOMPS_DIR=${path.join(intermediates, 'PrecompiledHeaders')}`,
  ];
}

export function resolveRunnerSandboxBuildArgs(
  env: NodeJS.ProcessEnv = hostEnvironment().env,
): string[] {
  const swiftFlags = `OTHER_SWIFT_FLAGS=${resolveRunnerSwiftFlags(env)}`;
  if (!isEnvTruthy(env.AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS)) {
    return [...RUNNER_SANDBOX_BUILD_ARGS, swiftFlags];
  }
  return [
    ...RUNNER_SANDBOX_BUILD_ARGS,
    swiftFlags,
    `OTHER_CFLAGS=$(inherited) ${RUNNER_UNIT_TEST_C_FLAGS}`,
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
      reason: RUNNER_BUILD_SETTINGS_REASONS.buildSettingsMismatch.reason,
      buildLogPath: logPath,
      differences,
      hint: 'Align the build invocation with the runner cache identity resolvers, or rebuild without the cache.',
    },
  );
}
