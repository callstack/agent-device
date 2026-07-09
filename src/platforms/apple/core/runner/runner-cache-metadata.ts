import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMacOs, type DeviceInfo } from '../../../../kernel/device.ts';
import { runCmdSync } from '../../../../utils/exec.ts';
import { isEnvTruthy } from '../../../../utils/retry.ts';
import { createTtlMemo } from '../../../../utils/ttl-memo.ts';
import { findProjectRoot, readVersion } from '../../../../utils/version.ts';
import {
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDerivedBaseName,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
} from '../apple-runner-platform.ts';
import { resolveAppleRunnerSourceRoot } from './runner-source.ts';

const DEFAULT_IOS_RUNNER_APP_BUNDLE_ID = 'com.callstack.agentdevice.runner';
const RUNNER_DERIVED_ROOT = path.join(os.homedir(), '.agent-device', 'apple-runner');
export const RUNNER_CACHE_METADATA_FILE = '.agent-device-runner-cache.json';
const RUNNER_CACHE_SCHEMA_VERSION = 2;
const RUNNER_SANDBOX_BUILD_ARGS = [
  '-IDEPackageSupportDisableManifestSandbox=1',
  '-IDEPackageSupportDisablePluginExecutionSandbox=1',
  'ENABLE_USER_SCRIPT_SANDBOXING=NO',
] as const;
const RUNNER_RUNTIME_SWIFT_FLAGS = '$(inherited) -disable-sandbox';
const RUNNER_UNIT_TEST_SWIFT_FLAGS =
  '$(inherited) -disable-sandbox -D AGENT_DEVICE_RUNNER_UNIT_TESTS';

const appleToolFingerprintCache = createTtlMemo<string, string>();

export type RunnerXctestrunCacheMetadata = {
  schemaVersion: number;
  packageVersion: string;
  runnerSourceFingerprint: string;
  xcodeVersion: string;
  xcodeBuildVersion: string;
  sdkName: string;
  sdkVersion: string;
  sdkBuildVersion: string;
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
    ...resolveRunnerToolchainFingerprint(platformName, device.kind),
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

function resolveRunnerToolchainFingerprint(
  platformName: ReturnType<typeof resolveRunnerPlatformName>,
  deviceKind: DeviceInfo['kind'],
): {
  xcodeVersion: string;
  xcodeBuildVersion: string;
  sdkName: string;
  sdkVersion: string;
  sdkBuildVersion: string;
} {
  const xcode = parseXcodeVersionOutput(runAppleToolFingerprintCommand('xcodebuild', ['-version']));
  const sdkName = resolveRunnerSdkName(platformName, deviceKind);
  return {
    xcodeVersion: xcode.version,
    xcodeBuildVersion: xcode.buildVersion,
    sdkName,
    sdkVersion: runAppleToolFingerprintCommand('xcrun', ['--sdk', sdkName, '--show-sdk-version']),
    sdkBuildVersion: runAppleToolFingerprintCommand('xcrun', [
      '--sdk',
      sdkName,
      '--show-sdk-build-version',
    ]),
  };
}

function runAppleToolFingerprintCommand(cmd: string, args: string[]): string {
  const cacheKey = JSON.stringify([cmd, args]);
  const cached = appleToolFingerprintCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const result = runCmdSync(cmd, args, {
      allowFailure: true,
      timeoutMs: 5_000,
      maxBuffer: 128 * 1024,
    });
    const value = result.exitCode === 0 ? result.stdout.trim() || 'unknown' : 'unknown';
    appleToolFingerprintCache.set(cacheKey, value);
    return value;
  } catch {
    appleToolFingerprintCache.set(cacheKey, 'unknown');
    return 'unknown';
  }
}

function parseXcodeVersionOutput(output: string): { version: string; buildVersion: string } {
  const version = output.match(/^Xcode\s+(.+)$/m)?.[1]?.trim() || 'unknown';
  const buildVersion = output.match(/^Build version\s+(.+)$/m)?.[1]?.trim() || 'unknown';
  return { version, buildVersion };
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

type RunnerSourceFingerprintCacheEntry = {
  fileStatsFingerprint: string;
  sourceFingerprint: string;
};

const runnerSourceFingerprintCache = new Map<string, RunnerSourceFingerprintCacheEntry>();

function computeRunnerSourceFingerprint(projectRoot: string): string {
  const runnerRoot = resolveAppleRunnerSourceRoot(projectRoot);
  const files = collectRunnerSourceFiles(runnerRoot);
  const fileStatsFingerprint = computeRunnerSourceFileStatsFingerprint(runnerRoot, files);
  const cached = runnerSourceFingerprintCache.get(runnerRoot);
  if (cached?.fileStatsFingerprint === fileStatsFingerprint) {
    return cached.sourceFingerprint;
  }
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const relativePath = path.relative(runnerRoot, file);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  const sourceFingerprint = hash.digest('hex');
  runnerSourceFingerprintCache.set(runnerRoot, { fileStatsFingerprint, sourceFingerprint });
  return sourceFingerprint;
}

function computeRunnerSourceFileStatsFingerprint(
  runnerRoot: string,
  files: readonly string[],
): string {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const relativePath = path.relative(runnerRoot, file);
    const stat = fs.statSync(file);
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(stat.size));
    hash.update('\0');
    hash.update(String(Math.trunc(stat.mtimeMs)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function collectRunnerSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'xcuserdata') continue;
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && isRunnerSourceFile(entry.name, fullPath)) {
        files.push(fullPath);
      }
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function isRunnerSourceFile(fileName: string, filePath: string): boolean {
  if (fileName === 'project.pbxproj') {
    return filePath.includes(`${path.sep}.xcodeproj${path.sep}`);
  }
  return [
    '.jpg',
    '.json',
    '.png',
    '.swift',
    '.m',
    '.h',
    '.plist',
    '.entitlements',
    '.xctestplan',
    '.xcconfig',
    '.storyboard',
    '.xib',
  ].includes(path.extname(fileName));
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
  const args = ['CODE_SIGN_STYLE=Automatic'];
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
