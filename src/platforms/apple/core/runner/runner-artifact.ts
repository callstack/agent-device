import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../../../../kernel/errors.ts';
import { runCmdStreaming, type ExecBackgroundResult } from '../../../../utils/exec.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import { withKeyedLock } from '../../../../utils/keyed-lock.ts';
import { isRequestCanceledError } from '../../../../request/cancel.ts';
import { emitRequestProgress } from '../../../../request/progress.ts';
import { findProjectRoot } from '../../../../utils/version.ts';
import { resolveRunnerBuildFailureHint } from './runner-contract.ts';
import { logChunk } from './runner-transport.ts';
import { acquireXcodebuildSimulatorSetRedirect } from './runner-device-set.ts';
import {
  acquireRunnerXctestrunCacheLock,
  assertSafeDerivedCleanup,
  cleanRunnerDerivedArtifacts,
  cleanRunnerDerivedBeforeEvaluation,
  emitRunnerXctestrunDecision,
  evaluateExistingXctestrun,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDerivedPath,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
  writeRunnerCacheMetadataForArtifacts,
  type ExistingXctestrunState,
  type RunnerXctestrunCacheKind,
  type RunnerXctestrunCacheMetadata,
} from './runner-cache.ts';
import {
  repairMacOsRunnerProductsIfNeeded,
  isExpectedRunnerRepairFailure,
} from './runner-macos-products.ts';
import { resolveExistingXctestrunProductPaths } from './runner-xctestrun-products.ts';
import { applyXctestRunnerAppIcon } from './runner-icon.ts';
import {
  resolveRunnerBuildDestination,
  resolveRunnerXctestrunHints,
} from '../apple-runner-platform.ts';
import { resolveAppleRunnerProjectPath } from './runner-source.ts';
export { prepareXctestrunWithEnv } from './runner-artifact-env.ts';

const runnerXctestrunBuildLocks = new Map<string, Promise<unknown>>();
export const runnerPrepProcesses = new Set<ExecBackgroundResult['child']>();

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

export async function ensureXctestrunArtifact(
  device: DeviceInfo,
  options: {
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    buildTimeoutMs?: number;
    forceRunnerXctestrunRebuild?: boolean;
    signal?: AbortSignal;
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
  options: {
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    buildTimeoutMs?: number;
    signal?: AbortSignal;
  };
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  forceRebuild: boolean;
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived } = params;
  cleanRunnerDerivedBeforeEvaluation(derived, params.forceRebuild);
  const existing = await evaluateExistingXctestrunForDevice({
    device,
    derived,
    projectRoot,
    expectedCacheMetadata,
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
  options: {
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    buildTimeoutMs?: number;
    signal?: AbortSignal;
  };
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  cache: RunnerXctestrunArtifact['cache'];
  reason: ExistingXctestrunState['reason'];
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived, cache, reason } = params;
  const projectPath = resolveAppleRunnerProjectPath(projectRoot);

  if (!fs.existsSync(projectPath)) {
    throw new AppError('COMMAND_FAILED', 'iOS runner project not found', { projectPath });
  }

  const buildStartedAt = Date.now();
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: 'Building Apple runner...',
  });
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
  // This covers direct local xcodebuilds triggered by ensureXctestrunArtifact on cache miss.
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

// Cache probe for preflight surfaces (doctor): runs the same no-build reuse
// evaluation as the ensure path (cache metadata + product-path validation),
// so a partial or stale cache never reports as ready. Resolving the expected
// metadata stats the runner sources and reads tool versions (~100ms, cached
// per process) but never builds.
export async function hasCachedAppleRunnerArtifact(device: DeviceInfo): Promise<boolean> {
  try {
    const projectRoot = findProjectRoot();
    const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(device, projectRoot);
    const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
    const existing = await evaluateExistingXctestrunForDevice({
      device,
      derived,
      projectRoot,
      expectedCacheMetadata,
    });
    return existing.reason === 'reuse_ready';
  } catch {
    return false;
  }
}

function evaluateExistingXctestrunForDevice(params: {
  device: DeviceInfo;
  derived: string;
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
}): Promise<ExistingXctestrunState> {
  const { device, derived, projectRoot, expectedCacheMetadata } = params;
  return evaluateExistingXctestrun({
    derived,
    projectRoot,
    expectedCacheMetadata,
    findXctestrun: (root) => findXctestrun(root, device),
    xctestrunReferencesProjectRoot,
    resolveExistingXctestrunProductPaths,
  });
}

type XctestrunCandidate = {
  path: string;
  mtimeMs: number;
};

export function findXctestrun(root: string, device?: DeviceInfo): string | null {
  const candidates = collectXctestrunCandidates(root);
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => compareXctestrunCandidates(left, right, device));
  return candidates[0]?.path ?? null;
}

function collectXctestrunCandidates(root: string): XctestrunCandidate[] {
  if (!fs.existsSync(root)) return [];
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
  return candidates;
}

function compareXctestrunCandidates(
  left: XctestrunCandidate,
  right: XctestrunCandidate,
  device: DeviceInfo | undefined,
): number {
  if (device) {
    const scoreDiff =
      scoreXctestrunCandidate(right.path, device) - scoreXctestrunCandidate(left.path, device);
    if (scoreDiff !== 0) return scoreDiff;
  }
  return right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path);
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

async function buildRunnerXctestrun(
  device: DeviceInfo,
  projectPath: string,
  derived: string,
  options: {
    verbose?: boolean;
    logPath?: string;
    traceLogPath?: string;
    buildTimeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const runnerBundleBuildSettings = resolveRunnerBundleBuildSettings(process.env);
  const signingBuildSettings = resolveRunnerSigningBuildSettings(
    process.env,
    device.kind === 'device',
    device,
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
        signal: options.signal,
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
    if (isRequestCanceledError(err)) throw err;
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
