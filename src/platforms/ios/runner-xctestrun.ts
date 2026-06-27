import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../utils/errors.ts';
import { runCmdStreaming, runCmdSync, type ExecBackgroundResult } from '../../utils/exec.ts';
import { resolveIosSimulatorDeviceSetPath } from '../../utils/device-isolation.ts';
import { readProcessStartTime } from '../../utils/process-identity.ts';
import { acquireProcessLock, type ProcessLockOwner } from '../../utils/process-lock.ts';
import { isEnvTruthy } from '../../utils/retry.ts';
import type { DeviceInfo } from '../../utils/device.ts';
import type { DefinedEnvMap as EnvMap } from '../../utils/env-map.ts';
import { withKeyedLock } from '../../utils/keyed-lock.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { findProjectRoot, readVersion } from '../../utils/version.ts';
import { resolveRunnerBuildFailureHint } from './runner-contract.ts';
import { logChunk } from './runner-transport.ts';
import { runAppleToolCommand } from './tool-provider.ts';
import {
  repairMacOsRunnerProductsIfNeeded,
  isExpectedRunnerRepairFailure,
} from './runner-macos-products.ts';
import { resolveExistingXctestrunProductPaths } from './runner-xctestrun-products.ts';
import { applyXctestRunnerAppIcon } from './runner-icon.ts';
import {
  resolveRunnerBuildDestination,
  resolveRunnerBuildDestinationFamily,
  resolveRunnerDerivedBaseName,
  resolveRunnerPlatformName,
  resolveRunnerSdkName,
  resolveRunnerXctestrunHints,
} from './apple-runner-platform.ts';
export {
  resolveRunnerBuildDestination,
  resolveRunnerDestination,
} from './apple-runner-platform.ts';

const DEFAULT_IOS_RUNNER_APP_BUNDLE_ID = 'com.callstack.agentdevice.runner';
const XCTEST_DEVICE_SET_BASE_NAME = 'XCTestDevices';
const XCTEST_DEVICE_SET_BACKUP_SUFFIX = '.agent-device-backup';
const XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX = '.agent-device-xctestdevices-backup-';

const RUNNER_DERIVED_ROOT = path.join(os.homedir(), '.agent-device', 'ios-runner');
const RUNNER_CACHE_METADATA_FILE = '.agent-device-runner-cache.json';
const RUNNER_CACHE_SCHEMA_VERSION = 2;
const XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS = 30_000;
const XCTEST_DEVICE_SET_LOCK_POLL_MS = 100;
const XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS = 5_000;
const RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS = 10 * 60_000;
const RUNNER_XCTESTRUN_CAPTURE_OPTIONS = {
  PreferredScreenCaptureFormat: 'screenshots',
  SystemAttachmentLifetime: 'keepNever',
  UserAttachmentLifetime: 'keepNever',
} as const;
const RUNNER_SANDBOX_BUILD_ARGS = [
  '-IDEPackageSupportDisableManifestSandbox=1',
  '-IDEPackageSupportDisablePluginExecutionSandbox=1',
  'ENABLE_USER_SCRIPT_SANDBOXING=NO',
  'OTHER_SWIFT_FLAGS=$(inherited) -disable-sandbox',
] as const;

const runnerXctestrunBuildLocks = new Map<string, Promise<unknown>>();
const badRunnerArtifactsForRun = new Set<string>();
const appleToolFingerprintCache = new Map<string, string>();
export const runnerPrepProcesses = new Set<ExecBackgroundResult['child']>();

type XctestrunTarget = {
  TestBundlePath?: unknown;
  EnvironmentVariables?: EnvMap;
  UITestEnvironmentVariables?: EnvMap;
  UITargetAppEnvironmentVariables?: EnvMap;
  TestingEnvironmentVariables?: EnvMap;
  [key: string]: unknown;
};
type XctestrunConfig = {
  TestTargets?: unknown;
  [key: string]: unknown;
};
type XctestrunPlist = {
  TestConfigurations?: unknown;
  [key: string]: unknown;
};
type XctestrunTargetVisitOptions = {
  requireTestBundlePath?: boolean;
};

type XcodebuildSimulatorSetRedirectHandle = {
  release: () => Promise<void>;
};

type XcodebuildSimulatorSetRedirectOptions = {
  xctestDeviceSetPath?: string;
  backupPath?: string;
  lockDirPath?: string;
  ownerPid?: number;
  ownerStartTime?: string | null;
  nowMs?: number;
};

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

export type RunnerXctestrunCacheKind = 'exact' | 'restore-key' | 'miss' | 'external';
export type RunnerXctestrunArtifactState = 'valid' | 'rebuilt';

export type RunnerXctestrunArtifact = {
  xctestrunPath: string;
  derived: string;
  cache: RunnerXctestrunCacheKind;
  artifact: RunnerXctestrunArtifactState;
  buildMs: number;
  xctestrunPathSource: 'manifest' | 'scan' | 'build' | 'external';
  reason?: string;
};

export type ExternalXctestRunnerOptions = {
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
};

type RunnerXctestrunCacheArtifacts = {
  xctestrunPath: string;
  xctestrunMtimeMs: number;
  xctestrunSize: number;
  productPaths: RunnerXctestrunCacheProductArtifact[];
};

type RunnerXctestrunCacheProductArtifact = {
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

export function resolveXcodebuildSimulatorDeviceSetPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library', 'Developer', 'XCTestDevices');
}

function resolveXcodebuildSimulatorDeviceSetLockPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.agent-device', 'xctest-device-set.lock');
}

function resolveXcodebuildSimulatorDeviceSetBackupPath(
  xctestDeviceSetPath: string = resolveXcodebuildSimulatorDeviceSetPath(),
): string {
  return `${xctestDeviceSetPath}${XCTEST_DEVICE_SET_BACKUP_SUFFIX}`;
}

export async function acquireXcodebuildSimulatorSetRedirect(
  device: DeviceInfo,
  options: XcodebuildSimulatorSetRedirectOptions = {},
): Promise<XcodebuildSimulatorSetRedirectHandle | null> {
  if (device.platform !== 'ios' || device.kind !== 'simulator') {
    return null;
  }
  const simulatorSetPath = resolveIosSimulatorDeviceSetPath(device.simulatorSetPath);
  if (!simulatorSetPath) {
    return null;
  }
  const requestedSetPath = path.resolve(simulatorSetPath);
  const xctestDeviceSetPath = path.resolve(
    options.xctestDeviceSetPath ?? resolveXcodebuildSimulatorDeviceSetPath(),
  );
  const backupPath = path.resolve(
    options.backupPath ?? resolveXcodebuildSimulatorDeviceSetBackupPath(xctestDeviceSetPath),
  );
  const lockDirPath = path.resolve(
    options.lockDirPath ?? resolveXcodebuildSimulatorDeviceSetLockPath(),
  );
  const ownerStartTime = options.ownerStartTime ?? readProcessStartTime(process.pid);
  const releaseLock = await acquireXcodebuildSimulatorSetLock({
    lockDirPath,
    owner: {
      pid: options.ownerPid ?? process.pid,
      startTime: ownerStartTime,
      acquiredAtMs: options.nowMs ?? Date.now(),
    },
  });

  try {
    reconcileXcodebuildSimulatorSetRedirect({
      xctestDeviceSetPath,
      backupPath,
    });
    if (sameResolvedPath(requestedSetPath, xctestDeviceSetPath)) {
      await releaseLock();
      return null;
    }

    fs.mkdirSync(requestedSetPath, { recursive: true });
    if (fs.existsSync(xctestDeviceSetPath)) {
      fs.renameSync(xctestDeviceSetPath, backupPath);
    }
    installXcodebuildSimulatorSetSymlink({
      requestedSetPath,
      xctestDeviceSetPath,
    });
  } catch (error) {
    reconcileXcodebuildSimulatorSetRedirect({
      xctestDeviceSetPath,
      backupPath,
    });
    await releaseLock();
    throw new AppError('COMMAND_FAILED', 'Failed to redirect XCTest device set path', {
      requestedSetPath,
      xctestDeviceSetPath,
      backupPath,
      error: String(error),
    });
  }

  let released = false;
  return {
    release: async () => {
      if (released) {
        return;
      }
      released = true;
      try {
        reconcileXcodebuildSimulatorSetRedirect({
          xctestDeviceSetPath,
          backupPath,
        });
      } finally {
        await releaseLock();
      }
    },
  };
}

// fallow-ignore-next-line complexity
function reconcileXcodebuildSimulatorSetRedirect(paths: {
  xctestDeviceSetPath: string;
  backupPath: string;
}): void {
  const { xctestDeviceSetPath, backupPath } = paths;
  const existingBackups = [backupPath, ...findLegacyXcodebuildSimulatorSetBackups(backupPath)];
  const activeBackupPath = existingBackups.find((candidate) => fs.existsSync(candidate));
  const xctestExists = fs.existsSync(xctestDeviceSetPath);
  const xctestIsSymlink = xctestExists && fs.lstatSync(xctestDeviceSetPath).isSymbolicLink();

  if (activeBackupPath) {
    if (xctestIsSymlink) {
      unlinkIfSymlink(xctestDeviceSetPath);
    }
    if (!fs.existsSync(xctestDeviceSetPath)) {
      fs.mkdirSync(path.dirname(xctestDeviceSetPath), { recursive: true });
      fs.renameSync(activeBackupPath, xctestDeviceSetPath);
    } else if (!xctestIsSymlink) {
      emitDiagnostic({
        level: 'warn',
        phase: 'ios_runner_xctest_device_set_restore_collision',
        data: {
          xctestDeviceSetPath,
          activeBackupPath,
        },
      });
      return;
    } else if (activeBackupPath !== backupPath) {
      fs.rmSync(activeBackupPath, { recursive: true, force: true });
    } else {
      fs.rmSync(backupPath, { recursive: true, force: true });
    }
    for (const candidate of existingBackups) {
      if (candidate !== activeBackupPath && fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    }
    return;
  }

  if (xctestIsSymlink) {
    emitDiagnostic({
      level: 'warn',
      phase: 'ios_runner_xctest_device_set_orphaned_symlink',
      data: {
        xctestDeviceSetPath,
      },
    });
    unlinkIfSymlink(xctestDeviceSetPath);
  }
}

function findLegacyXcodebuildSimulatorSetBackups(backupPath: string): string[] {
  const parentDir = path.dirname(backupPath);
  const backupBaseName = path.basename(backupPath).replace(XCTEST_DEVICE_SET_BACKUP_SUFFIX, '');
  const legacyPrefix =
    backupBaseName === XCTEST_DEVICE_SET_BASE_NAME
      ? XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX
      : `${backupBaseName}${XCTEST_DEVICE_SET_LEGACY_BACKUP_PREFIX}`;
  try {
    return fs
      .readdirSync(parentDir)
      .filter((entry) => entry.startsWith(legacyPrefix))
      .sort()
      .map((entry) => path.join(parentDir, entry));
  } catch {
    return [];
  }
}

function installXcodebuildSimulatorSetSymlink(paths: {
  requestedSetPath: string;
  xctestDeviceSetPath: string;
}): void {
  const { requestedSetPath, xctestDeviceSetPath } = paths;
  const parentDir = path.dirname(xctestDeviceSetPath);
  const tmpSymlinkPath = path.join(
    parentDir,
    `${XCTEST_DEVICE_SET_BASE_NAME}.agent-device-link-${process.pid}-${Date.now()}`,
  );
  fs.mkdirSync(parentDir, { recursive: true });
  try {
    fs.symlinkSync(requestedSetPath, tmpSymlinkPath, 'dir');
    fs.renameSync(tmpSymlinkPath, xctestDeviceSetPath);
  } catch (error) {
    if (fs.existsSync(tmpSymlinkPath)) {
      unlinkIfSymlink(tmpSymlinkPath);
    }
    throw error;
  }
}

function unlinkIfSymlink(targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  if (!fs.lstatSync(targetPath).isSymbolicLink()) {
    return;
  }
  fs.unlinkSync(targetPath);
}

function sameResolvedPath(left: string, right: string): boolean {
  if (path.resolve(left) === path.resolve(right)) {
    return true;
  }
  try {
    return fs.realpathSync.native(left) === fs.realpathSync.native(right);
  } catch {
    return false;
  }
}

async function acquireXcodebuildSimulatorSetLock(params: {
  lockDirPath: string;
  owner: ProcessLockOwner;
  timeoutMs?: number;
  pollMs?: number;
  description?: string;
}): Promise<() => Promise<void>> {
  return await acquireProcessLock({
    lockDirPath: params.lockDirPath,
    owner: params.owner,
    timeoutMs: params.timeoutMs ?? XCTEST_DEVICE_SET_LOCK_TIMEOUT_MS,
    pollMs: params.pollMs ?? XCTEST_DEVICE_SET_LOCK_POLL_MS,
    ownerGraceMs: XCTEST_DEVICE_SET_LOCK_OWNER_GRACE_MS,
    description: params.description ?? 'XCTest device set lock',
  });
}

export async function acquireRunnerXctestrunCacheLock(
  derived: string,
): Promise<() => Promise<void>> {
  return await acquireXcodebuildSimulatorSetLock({
    lockDirPath: resolveRunnerXctestrunCacheLockPath(derived),
    owner: {
      pid: process.pid,
      startTime: readProcessStartTime(process.pid),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS,
    description: 'iOS runner cache lock',
  });
}

function resolveRunnerXctestrunCacheLockPath(derived: string): string {
  return path.join(path.dirname(derived), `${path.basename(derived)}.lock`);
}

export async function ensureXctestrun(
  device: DeviceInfo,
  options: {
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    buildTimeoutMs?: number;
  } & ExternalXctestRunnerOptions,
): Promise<string> {
  return (await ensureXctestrunArtifact(device, options)).xctestrunPath;
}

export async function ensureXctestrunArtifact(
  device: DeviceInfo,
  options: {
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    buildTimeoutMs?: number;
    forceRunnerXctestrunRebuild?: boolean;
  } & ExternalXctestRunnerOptions,
): Promise<RunnerXctestrunArtifact> {
  const external = resolveExternalXctestrunArtifact(options);
  if (external) return external;

  const projectRoot = findProjectRoot();
  const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(device, projectRoot);
  const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
  return await withKeyedLock(runnerXctestrunBuildLocks, derived, async () => {
    const releaseCacheLock = await acquireRunnerXctestrunCacheLock(derived);
    try {
      return await ensureXctestrunUnderCacheLock({
        device,
        options,
        projectRoot,
        expectedCacheMetadata,
        derived,
        forceRebuild: options.forceRunnerXctestrunRebuild === true,
      });
    } finally {
      await releaseCacheLock();
    }
  });
}

function resolveExternalXctestrunArtifact(
  options: ExternalXctestRunnerOptions,
): RunnerXctestrunArtifact | null {
  const configuredXctestrunPath = options.iosXctestrunFile?.trim();
  if (!configuredXctestrunPath) {
    return null;
  }

  const xctestrunPath = path.resolve(configuredXctestrunPath);
  if (!fs.existsSync(xctestrunPath)) {
    throw new AppError('COMMAND_FAILED', 'Configured iOS XCTest runner .xctestrun file not found', {
      configKey: 'iosXctestrunFile',
      xctestrunPath,
    });
  }

  const configuredDerivedPath = options.iosXctestDerivedDataPath?.trim();
  const derived = configuredDerivedPath
    ? path.resolve(configuredDerivedPath)
    : resolveExternalXctestDerivedDataPath(xctestrunPath);

  emitRunnerXctestrunDecision('reuse', 'external_xctestrun', {
    derived,
    xctestrunPath,
  });

  return {
    xctestrunPath,
    derived,
    cache: 'external',
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: 'external',
  };
}

function resolveExternalXctestDerivedDataPath(xctestrunPath: string): string {
  const hash = crypto.createHash('sha1');
  hash.update(xctestrunPath);
  const suffix = hash.digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), 'agent-device-ios-xctest-derived', suffix);
}

async function ensureXctestrunUnderCacheLock(params: {
  device: DeviceInfo;
  options: { verbose?: boolean; logPath?: string; traceLogPath?: string; buildTimeoutMs?: number };
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  forceRebuild: boolean;
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived } = params;
  cleanRunnerDerivedBeforeEvaluation(derived, params.forceRebuild);
  const existing = await evaluateExistingXctestrun({
    derived,
    projectRoot,
    expectedCacheMetadata,
    findXctestrun: (root) => findXctestrun(root, device),
    xctestrunReferencesProjectRoot,
    resolveExistingXctestrunProductPaths,
  });
  const cache =
    existing.reason === 'reuse_ready' ? 'exact' : existing.xctestrunPath ? 'restore-key' : 'miss';
  if (existing.reason !== 'reuse_ready') {
    emitRunnerXctestrunDecision('rebuild', existing.reason, {
      derived,
      xctestrunPath: existing.xctestrunPath,
    });
  }
  const reusable = await resolveReusableXctestrunArtifact({
    device,
    derived,
    expectedCacheMetadata,
    existing,
    cache,
  });
  if (reusable) return reusable;
  if (existing.xctestrunPath) {
    assertSafeDerivedCleanup(derived);
    cleanRunnerDerivedArtifacts(derived);
  }
  return await buildXctestrunArtifact({
    device,
    options,
    projectRoot,
    expectedCacheMetadata,
    derived,
    cache,
    reason: existing.reason,
  });
}

function cleanRunnerDerivedBeforeEvaluation(derived: string, forceRebuild: boolean): void {
  if (!shouldCleanDerived() && !forceRebuild && !badRunnerArtifactsForRun.has(derived)) {
    return;
  }
  emitRunnerXctestrunDecision('clean', forceRebuild ? 'forced_rebuild' : 'forced_clean', {
    derived,
  });
  assertSafeDerivedCleanup(derived);
  cleanRunnerDerivedArtifacts(derived);
  badRunnerArtifactsForRun.delete(derived);
}

async function resolveReusableXctestrunArtifact(params: {
  device: DeviceInfo;
  derived: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  existing: ExistingXctestrunState;
  cache: RunnerXctestrunArtifact['cache'];
}): Promise<RunnerXctestrunArtifact | null> {
  const { device, derived, expectedCacheMetadata, existing, cache } = params;
  if (existing.reason !== 'reuse_ready') return null;
  const reusableXctestrun = await tryReuseExistingXctestrun(
    device,
    derived,
    expectedCacheMetadata,
    existing,
  );
  if (!reusableXctestrun) return null;
  return {
    xctestrunPath: reusableXctestrun,
    derived,
    cache,
    artifact: 'valid',
    buildMs: 0,
    xctestrunPathSource: existing.source,
  };
}

async function buildXctestrunArtifact(params: {
  device: DeviceInfo;
  options: { verbose?: boolean; logPath?: string; traceLogPath?: string; buildTimeoutMs?: number };
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  cache: RunnerXctestrunArtifact['cache'];
  reason: ExistingXctestrunState['reason'];
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived, cache, reason } = params;
  const projectPath = path.join(
    projectRoot,
    'ios-runner',
    'AgentDeviceRunner',
    'AgentDeviceRunner.xcodeproj',
  );

  if (!fs.existsSync(projectPath)) {
    throw new AppError('COMMAND_FAILED', 'iOS runner project not found', { projectPath });
  }

  const buildStartedAt = Date.now();
  await buildRunnerXctestrun(device, projectPath, derived, options);
  const buildMs = Math.max(0, Date.now() - buildStartedAt);

  const built = findXctestrun(derived, device);
  if (!built) {
    throw new AppError('COMMAND_FAILED', 'Failed to locate .xctestrun after build');
  }
  const builtProductPaths = await resolveExistingXctestrunProductPaths(built);
  if (!builtProductPaths) {
    throw new AppError('COMMAND_FAILED', 'Runner build is missing expected products', {
      xctestrunPath: built,
    });
  }
  await repairMacOsRunnerProductsIfNeeded(device, builtProductPaths, built);
  // Release/dev script builds patch the synthesized XCTest runner app in scripts/.
  // This covers direct local xcodebuilds triggered by ensureXctestrun on cache miss.
  await applyXctestRunnerAppIcon(builtProductPaths);
  writeRunnerCacheMetadataForArtifacts(derived, expectedCacheMetadata, built, builtProductPaths);
  emitRunnerXctestrunDecision('build', 'built_new', {
    derived,
    xctestrunPath: built,
  });
  return {
    xctestrunPath: built,
    derived,
    cache,
    artifact: 'rebuilt',
    buildMs,
    xctestrunPathSource: 'build',
    reason,
  };
}

async function tryReuseExistingXctestrun(
  device: DeviceInfo,
  derived: string,
  expectedCacheMetadata: RunnerXctestrunCacheMetadata,
  existing: Extract<ExistingXctestrunState, { reason: 'reuse_ready' }>,
): Promise<string | null> {
  try {
    await repairMacOsRunnerProductsIfNeeded(device, existing.productPaths, existing.xctestrunPath);
    emitRunnerXctestrunDecision('reuse', 'reuse_ready', {
      derived,
      xctestrunPath: existing.xctestrunPath,
    });
    writeRunnerCacheMetadataForArtifacts(
      derived,
      expectedCacheMetadata,
      existing.xctestrunPath,
      existing.productPaths,
    );
    return existing.xctestrunPath;
  } catch (error) {
    if (!isExpectedRunnerRepairFailure(error)) {
      throw error;
    }
    emitRunnerXctestrunDecision('rebuild', 'repair_failed', {
      derived,
      xctestrunPath: existing.xctestrunPath,
    });
    return null;
  }
}

function writeRunnerCacheMetadataForArtifacts(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata,
  xctestrunPath: string,
  productPaths: string[],
): void {
  writeRunnerCacheMetadata(
    derived,
    withRunnerCacheArtifacts(metadata, xctestrunPath, productPaths),
  );
}

function cleanRunnerDerivedArtifacts(derived: string): void {
  try {
    if (!fs.existsSync(derived)) return;
    if (path.basename(derived) !== 'derived') {
      fs.rmSync(derived, { recursive: true, force: true });
      return;
    }
    for (const entry of fs.readdirSync(derived, { withFileTypes: true })) {
      if (!shouldDeleteRunnerDerivedRootEntry(entry.name)) continue;
      fs.rmSync(path.join(derived, entry.name), { recursive: true, force: true });
    }
  } catch {}
}

const RUNNER_ROOT_TRANSIENT_ENTRY_NAMES = new Set([
  RUNNER_CACHE_METADATA_FILE,
  'Build',
  'BuildCache.noindex',
  'Index.noindex',
  'Logs',
  'ModuleCache.noindex',
  'SDKStatCaches.noindex',
  'SourcePackages',
  'TextBasedInstallAPI',
  'info.plist',
]);

export function __resetRunnerToolchainFingerprintCacheForTests(): void {
  appleToolFingerprintCache.clear();
}

export function shouldDeleteRunnerDerivedRootEntry(entryName: string): boolean {
  return RUNNER_ROOT_TRANSIENT_ENTRY_NAMES.has(entryName);
}

export function resolveRunnerCacheMetadataPath(derived: string): string {
  return path.join(derived, RUNNER_CACHE_METADATA_FILE);
}

export function resolveExpectedRunnerCacheMetadata(
  device: DeviceInfo,
  projectRoot: string = findProjectRoot(),
): RunnerXctestrunCacheMetadata {
  const platformName = resolveRunnerPlatformName(device);
  return {
    schemaVersion: RUNNER_CACHE_SCHEMA_VERSION,
    packageVersion: readVersion(),
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
      device.platform,
    ),
    runnerPerformanceBuildSettings: resolveRunnerPerformanceBuildSettings(),
    runnerSandboxBuildArgs: resolveRunnerSandboxBuildArgs(),
  };
}

function resolveRunnerToolchainFingerprint(
  platformName: 'iOS' | 'tvOS' | 'macOS',
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

export function writeRunnerCacheMetadata(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata,
): void {
  fs.mkdirSync(derived, { recursive: true });
  fs.writeFileSync(
    resolveRunnerCacheMetadataPath(derived),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export async function markRunnerXctestrunArtifactBadForRun(
  artifact: Pick<RunnerXctestrunArtifact, 'cache' | 'derived' | 'xctestrunPath'>,
  reason: string,
): Promise<void> {
  if (artifact.cache === 'external') {
    emitRunnerXctestrunDecision('preserve', 'external_bad_artifact', {
      derived: artifact.derived,
      xctestrunPath: artifact.xctestrunPath,
      reason,
    });
    return;
  }

  badRunnerArtifactsForRun.add(artifact.derived);
  const releaseCacheLock = await acquireRunnerXctestrunCacheLock(artifact.derived);
  try {
    emitRunnerXctestrunDecision('clean', 'bad_artifact', {
      derived: artifact.derived,
      xctestrunPath: artifact.xctestrunPath,
      reason,
    });
    assertSafeDerivedCleanup(artifact.derived);
    cleanRunnerDerivedArtifacts(artifact.derived);
  } finally {
    await releaseCacheLock();
  }
}

function readRunnerCacheMetadata(derived: string): RunnerXctestrunCacheMetadata | null {
  try {
    const raw: unknown = JSON.parse(
      fs.readFileSync(resolveRunnerCacheMetadataPath(derived), 'utf8'),
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    return raw as RunnerXctestrunCacheMetadata;
  } catch {
    return null;
  }
}

function evaluateRunnerCacheMetadata(
  derived: string,
  expected: RunnerXctestrunCacheMetadata,
):
  | { ok: true; metadata: RunnerXctestrunCacheMetadata }
  | { ok: false; reason: 'cache_metadata_missing' | 'cache_metadata_mismatch' } {
  const actual = readRunnerCacheMetadata(derived);
  if (!actual) {
    return { ok: false, reason: 'cache_metadata_missing' };
  }
  if (
    stableJsonStringify(comparableRunnerCacheMetadata(actual)) !==
    stableJsonStringify(comparableRunnerCacheMetadata(expected))
  ) {
    return { ok: false, reason: 'cache_metadata_mismatch' };
  }
  return { ok: true, metadata: actual };
}

function comparableRunnerCacheMetadata(
  metadata: RunnerXctestrunCacheMetadata,
): RunnerXctestrunCacheMetadata {
  const { artifacts: _artifacts, ...comparable } = metadata;
  return comparable;
}

function resolveRunnerDerivedCacheKey(metadata: RunnerXctestrunCacheMetadata): string {
  const hash = crypto
    .createHash('sha256')
    .update(stableJsonStringify(comparableRunnerCacheMetadata(metadata)))
    .digest('hex');
  return `cache-${hash.slice(0, 16)}`;
}

function stableJsonStringify(value: unknown): string {
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

function withRunnerCacheArtifacts(
  metadata: RunnerXctestrunCacheMetadata,
  xctestrunPath: string,
  productPaths: readonly string[],
): RunnerXctestrunCacheMetadata {
  const artifacts = buildRunnerCacheArtifacts(xctestrunPath, productPaths);
  return artifacts ? { ...metadata, artifacts } : metadata;
}

function buildRunnerCacheArtifacts(
  xctestrunPath: string,
  productPaths: readonly string[],
): RunnerXctestrunCacheArtifacts | null {
  const xctestrunStats = readPathSignature(xctestrunPath);
  if (xctestrunStats === null || productPaths.length === 0) {
    return null;
  }
  const productArtifacts: RunnerXctestrunCacheProductArtifact[] = [];
  for (const productPath of productPaths) {
    const stats = readPathSignature(productPath);
    if (stats === null) {
      return null;
    }
    productArtifacts.push({ path: productPath, ...stats });
  }
  return {
    xctestrunPath,
    xctestrunMtimeMs: xctestrunStats.mtimeMs,
    xctestrunSize: xctestrunStats.size,
    productPaths: productArtifacts,
  };
}

function readValidatedRunnerCacheArtifacts(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata | null,
): { xctestrunPath: string; productPaths: string[] } | null {
  const artifacts = metadata?.artifacts;
  if (!isRunnerCacheArtifacts(artifacts)) {
    return null;
  }
  if (!isPathInsideDirectory(artifacts.xctestrunPath, derived)) {
    return null;
  }
  if (
    !pathSignatureMatches(artifacts.xctestrunPath, {
      mtimeMs: artifacts.xctestrunMtimeMs,
      size: artifacts.xctestrunSize,
    })
  ) {
    return null;
  }
  const productPaths: string[] = [];
  for (const product of artifacts.productPaths) {
    if (!isPathInsideDirectory(product.path, derived)) {
      return null;
    }
    if (!pathSignatureMatches(product.path, product)) {
      return null;
    }
    productPaths.push(product.path);
  }
  return { xctestrunPath: artifacts.xctestrunPath, productPaths };
}

function isRunnerCacheArtifacts(value: unknown): value is RunnerXctestrunCacheArtifacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const artifacts = value as Partial<RunnerXctestrunCacheArtifacts>;
  return (
    typeof artifacts.xctestrunPath === 'string' &&
    Number.isInteger(artifacts.xctestrunMtimeMs) &&
    Number.isInteger(artifacts.xctestrunSize) &&
    Array.isArray(artifacts.productPaths) &&
    artifacts.productPaths.length > 0 &&
    artifacts.productPaths.every(isRunnerCacheProductArtifact)
  );
}

function isRunnerCacheProductArtifact(
  value: unknown,
): value is RunnerXctestrunCacheProductArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const product = value as Partial<RunnerXctestrunCacheProductArtifact>;
  return (
    typeof product.path === 'string' &&
    Number.isInteger(product.mtimeMs) &&
    Number.isInteger(product.size)
  );
}

function readPathSignature(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { mtimeMs: Math.trunc(stat.mtimeMs), size: stat.size };
  } catch {
    return null;
  }
}

function pathSignatureMatches(
  filePath: string,
  expected: { mtimeMs: number; size: number },
): boolean {
  const actual = readPathSignature(filePath);
  return actual?.mtimeMs === expected.mtimeMs && actual.size === expected.size;
}

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
  const relativePath = path.relative(path.resolve(directoryPath), path.resolve(targetPath));
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

type RunnerSourceFingerprintCacheEntry = {
  fileStatsFingerprint: string;
  sourceFingerprint: string;
};

const runnerSourceFingerprintCache = new Map<string, RunnerSourceFingerprintCacheEntry>();

function computeRunnerSourceFingerprint(projectRoot: string): string {
  const runnerRoot = path.join(projectRoot, 'ios-runner', 'AgentDeviceRunner');
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

type XctestrunCandidate = {
  path: string;
  mtimeMs: number;
};

export function findXctestrun(root: string, device?: DeviceInfo): string | null {
  if (!fs.existsSync(root)) return null;
  const candidates: XctestrunCandidate[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.xctestrun')) {
        try {
          const stat = fs.statSync(full);
          candidates.push({ path: full, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (device) {
      const scoreDiff =
        scoreXctestrunCandidate(b.path, device) - scoreXctestrunCandidate(a.path, device);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }
    }
    return b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path);
  });
  return candidates[0]?.path ?? null;
}

export function scoreXctestrunCandidate(candidatePath: string, device: DeviceInfo): number {
  let score = 0;
  const normalizedPath = candidatePath.toLowerCase();
  const fileName = path.basename(normalizedPath);

  if (fileName.startsWith('agentdevicerunner.env.')) {
    score -= 1_000;
  }

  if (normalizedPath.includes(`${path.sep}macos${path.sep}`)) {
    score -= 5_000;
  }

  const platformHints = resolveRunnerXctestrunHints(device);
  if (platformHints.preferred.length > 0) {
    if (platformHints.preferred.some((hint) => normalizedPath.includes(hint))) {
      score += 2_000;
    } else {
      score -= 500;
    }
  }

  if (platformHints.disallowed.some((hint) => normalizedPath.includes(hint))) {
    score -= 2_500;
  }

  return score;
}

export function xctestrunReferencesProjectRoot(
  xctestrunPath: string,
  projectRoot: string,
): boolean {
  try {
    const contents = fs.readFileSync(xctestrunPath, 'utf8');
    const candidateRoots = new Set<string>([projectRoot]);
    try {
      candidateRoots.add(fs.realpathSync(projectRoot));
    } catch {}
    for (const root of candidateRoots) {
      if (contents.includes(root)) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function prepareXctestrunWithEnv(
  xctestrunPath: string,
  envVars: Record<string, string>,
  suffix: string,
  options: Pick<ExternalXctestRunnerOptions, 'iosXctestEnvDir'> = {},
): Promise<{ xctestrunPath: string; jsonPath: string }> {
  const configuredEnvDir = options.iosXctestEnvDir?.trim();
  const dir = configuredEnvDir ? path.resolve(configuredEnvDir) : path.dirname(xctestrunPath);
  fs.mkdirSync(dir, { recursive: true });
  const safeSuffix = suffix.replace(/[^a-zA-Z0-9._-]/g, '_');
  const tmpJsonPath = path.join(dir, `AgentDeviceRunner.env.${safeSuffix}.json`);
  const tmpXctestrunPath = path.join(dir, `AgentDeviceRunner.env.${safeSuffix}.xctestrun`);
  const parsed = await readXctestrunPlist(xctestrunPath);

  visitXctestrunTargets(parsed, (target) => mergeEnvIntoXctestrunTarget(target, envVars));
  // Xcode 26.2 can emit attachment lifetime values that differ from the test plan,
  // so normalize the per-session xctestrun immediately before test-without-building.
  applyRunnerXctestrunCapturePolicy(parsed);
  await writeXctestrunPlist(parsed, tmpJsonPath, tmpXctestrunPath);

  return { xctestrunPath: tmpXctestrunPath, jsonPath: tmpJsonPath };
}

async function readXctestrunPlist(xctestrunPath: string): Promise<XctestrunPlist> {
  const jsonResult = await runAppleToolCommand(
    'plutil',
    ['-convert', 'json', '-o', '-', xctestrunPath],
    {
      allowFailure: true,
    },
  );
  if (jsonResult.exitCode !== 0 || !jsonResult.stdout.trim()) {
    throw new AppError('COMMAND_FAILED', 'Failed to read xctestrun plist', {
      xctestrunPath,
      stderr: jsonResult.stderr,
    });
  }

  try {
    const raw: unknown = JSON.parse(jsonResult.stdout);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Root must be an object');
    }
    return raw as XctestrunPlist;
  } catch (err) {
    throw new AppError('COMMAND_FAILED', 'Failed to parse xctestrun JSON', {
      xctestrunPath,
      error: String(err),
    });
  }
}

async function writeXctestrunPlist(
  parsed: XctestrunPlist,
  tmpJsonPath: string,
  tmpXctestrunPath: string,
): Promise<void> {
  fs.writeFileSync(tmpJsonPath, JSON.stringify(parsed, null, 2));
  const plistResult = await runAppleToolCommand(
    'plutil',
    ['-convert', 'xml1', '-o', tmpXctestrunPath, tmpJsonPath],
    {
      allowFailure: true,
    },
  );
  if (plistResult.exitCode !== 0) {
    throw new AppError('COMMAND_FAILED', 'Failed to write xctestrun plist', {
      tmpXctestrunPath,
      stderr: plistResult.stderr,
    });
  }
}

function mergeEnvIntoXctestrunTarget(
  target: XctestrunTarget,
  envVars: Record<string, string>,
): void {
  target.EnvironmentVariables = { ...(target.EnvironmentVariables ?? {}), ...envVars };
  target.UITestEnvironmentVariables = { ...(target.UITestEnvironmentVariables ?? {}), ...envVars };
  target.UITargetAppEnvironmentVariables = {
    ...(target.UITargetAppEnvironmentVariables ?? {}),
    ...envVars,
  };
  target.TestingEnvironmentVariables = {
    ...(target.TestingEnvironmentVariables ?? {}),
    ...envVars,
  };
}

function applyRunnerXctestrunCapturePolicy(parsed: XctestrunPlist): void {
  visitXctestrunTargets(
    parsed,
    (target) => Object.assign(target, RUNNER_XCTESTRUN_CAPTURE_OPTIONS),
    { requireTestBundlePath: true },
  );
}

function visitXctestrunTargets(
  parsed: XctestrunPlist,
  visit: (target: XctestrunTarget) => void,
  options: XctestrunTargetVisitOptions = {},
): void {
  const configs = parsed.TestConfigurations;
  if (Array.isArray(configs)) {
    for (const config of configs as XctestrunConfig[]) {
      if (!config || typeof config !== 'object') continue;
      visitTargets(config.TestTargets, visit, options);
    }
  }

  for (const value of Object.values(parsed)) {
    const target = toXctestrunTarget(value, { requireTestBundlePath: true });
    if (target) visit(target);
  }
}

function visitTargets(
  targets: unknown,
  visit: (target: XctestrunTarget) => void,
  options: XctestrunTargetVisitOptions,
): void {
  if (!Array.isArray(targets)) return;
  for (const target of targets) {
    const parsed = toXctestrunTarget(target, options);
    if (parsed) visit(parsed);
  }
}

function toXctestrunTarget(
  value: unknown,
  options: XctestrunTargetVisitOptions,
): XctestrunTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as XctestrunTarget;
  if (options.requireTestBundlePath && !target.TestBundlePath) return null;
  return target;
}

async function buildRunnerXctestrun(
  device: DeviceInfo,
  projectPath: string,
  derived: string,
  options: { verbose?: boolean; logPath?: string; traceLogPath?: string; buildTimeoutMs?: number },
): Promise<void> {
  const runnerBundleBuildSettings = resolveRunnerBundleBuildSettings(process.env);
  const signingBuildSettings = resolveRunnerSigningBuildSettings(
    process.env,
    device.kind === 'device',
    device.platform,
  );
  const provisioningArgs = device.kind === 'device' ? ['-allowProvisioningUpdates'] : [];
  const performanceBuildSettings = resolveRunnerPerformanceBuildSettings();
  const sandboxBuildArgs = resolveRunnerSandboxBuildArgs();
  const simulatorSetRedirect = await acquireXcodebuildSimulatorSetRedirect(device);
  try {
    await runCmdStreaming(
      'xcodebuild',
      [
        'build-for-testing',
        '-project',
        projectPath,
        '-scheme',
        'AgentDeviceRunner',
        '-parallel-testing-enabled',
        'NO',
        resolveRunnerMaxConcurrentDestinationsFlag(device),
        '1',
        '-destination',
        resolveRunnerBuildDestination(device),
        '-derivedDataPath',
        derived,
        ...performanceBuildSettings,
        ...sandboxBuildArgs,
        ...runnerBundleBuildSettings,
        ...provisioningArgs,
        ...signingBuildSettings,
      ],
      {
        detached: true,
        timeoutMs: options.buildTimeoutMs,
        onSpawn: (child) => {
          runnerPrepProcesses.add(child);
          child.on('close', () => {
            runnerPrepProcesses.delete(child);
          });
        },
        onStdoutChunk: (chunk) => {
          logChunk(chunk, options.logPath, options.traceLogPath, options.verbose);
        },
        onStderrChunk: (chunk) => {
          logChunk(chunk, options.logPath, options.traceLogPath, options.verbose);
        },
      },
    );
  } catch (err) {
    const appErr = err instanceof AppError ? err : new AppError('COMMAND_FAILED', String(err));
    const hint = resolveRunnerBuildFailureHint(appErr);
    throw new AppError('COMMAND_FAILED', 'xcodebuild build-for-testing failed', {
      error: appErr.message,
      details: appErr.details,
      logPath: options.logPath,
      hint,
    });
  } finally {
    await simulatorSetRedirect?.release();
  }
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

export function resolveRunnerMaxConcurrentDestinationsFlag(device: DeviceInfo): string {
  if (device.platform === 'macos') {
    return '-maximum-concurrent-test-device-destinations';
  }
  return device.kind === 'device'
    ? '-maximum-concurrent-test-device-destinations'
    : '-maximum-concurrent-test-simulator-destinations';
}

export function resolveRunnerSigningBuildSettings(
  env: NodeJS.ProcessEnv = process.env,
  forDevice = false,
  platform: DeviceInfo['platform'] = 'ios',
): string[] {
  if (platform === 'macos') {
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
  return [...RUNNER_SANDBOX_BUILD_ARGS];
}

function shouldCleanDerived(): boolean {
  return isEnvTruthy(process.env.AGENT_DEVICE_IOS_CLEAN_DERIVED);
}

export function assertSafeDerivedCleanup(
  derivedPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const override = env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH?.trim();
  if (!override) {
    return;
  }
  if (isPathInsideProjectTmp(derivedPath)) {
    return;
  }
  throw new AppError(
    'COMMAND_FAILED',
    'Refusing to clean AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH automatically',
    {
      derivedPath,
      hint: `Unset AGENT_DEVICE_IOS_CLEAN_DERIVED, or move AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH under a subdirectory of ${path.join(findProjectRoot(), '.tmp')}.`,
    },
  );
}

function isPathInsideProjectTmp(targetPath: string): boolean {
  const projectTmpRoot = path.resolve(findProjectRoot(), '.tmp');
  const relativePath = path.relative(projectTmpRoot, path.resolve(targetPath));
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

type ExistingXctestrunState =
  | {
      reason: 'missing_xctestrun';
      xctestrunPath: null;
    }
  | {
      reason: 'reuse_ready';
      xctestrunPath: string;
      productPaths: string[];
      source: 'manifest' | 'scan';
    }
  | {
      reason:
        | 'project_root_mismatch'
        | 'missing_products'
        | 'cache_metadata_missing'
        | 'cache_metadata_mismatch';
      xctestrunPath: string;
      productPaths: string[];
      source: 'manifest' | 'scan';
    };

// fallow-ignore-next-line complexity
async function evaluateExistingXctestrun(options: {
  derived: string;
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  findXctestrun: (root: string) => string | null;
  xctestrunReferencesProjectRoot: (xctestrunPath: string, projectRoot: string) => boolean;
  resolveExistingXctestrunProductPaths: (xctestrunPath: string) => Promise<string[] | null>;
}): Promise<ExistingXctestrunState> {
  const cacheMetadata = evaluateRunnerCacheMetadata(options.derived, options.expectedCacheMetadata);
  const manifest = cacheMetadata.ok
    ? readValidatedRunnerCacheArtifacts(options.derived, cacheMetadata.metadata)
    : null;
  const xctestrunPath = manifest?.xctestrunPath ?? options.findXctestrun(options.derived);
  if (!xctestrunPath) {
    return { reason: 'missing_xctestrun', xctestrunPath: null };
  }
  const hasValidatedManifest = manifest?.xctestrunPath === xctestrunPath;
  const source = hasValidatedManifest ? 'manifest' : 'scan';
  const productPaths = hasValidatedManifest
    ? manifest.productPaths
    : await options.resolveExistingXctestrunProductPaths(xctestrunPath);
  if (!productPaths) {
    return { reason: 'missing_products', xctestrunPath, productPaths: [], source };
  }
  if (
    !options.xctestrunReferencesProjectRoot(xctestrunPath, options.projectRoot) &&
    !hasValidatedManifest
  ) {
    return { reason: 'project_root_mismatch', xctestrunPath, productPaths, source };
  }
  if (!cacheMetadata.ok) {
    return { reason: cacheMetadata.reason, xctestrunPath, productPaths, source };
  }
  return { reason: 'reuse_ready', xctestrunPath, productPaths, source };
}

function emitRunnerXctestrunDecision(
  action: 'clean' | 'reuse' | 'rebuild' | 'build' | 'preserve',
  reason:
    | 'forced_clean'
    | 'missing_xctestrun'
    | 'project_root_mismatch'
    | 'missing_products'
    | 'cache_metadata_missing'
    | 'cache_metadata_mismatch'
    | 'repair_failed'
    | 'reuse_ready'
    | 'forced_rebuild'
    | 'bad_artifact'
    | 'built_new'
    | 'external_xctestrun'
    | 'external_bad_artifact',
  data: Record<string, unknown>,
): void {
  emitDiagnostic({
    level: action === 'rebuild' ? 'warn' : 'info',
    phase: 'runner_xctestrun_cache',
    data: {
      action,
      reason,
      ...data,
    },
  });
}
