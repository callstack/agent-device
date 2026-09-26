import { AppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  runCmdStreaming,
  withKeyedLock,
  withProcessLock,
  emitRequestProgress,
  findProjectRoot,
  isCommandTimeoutError,
} from './host.ts';
import type { ExecBackgroundResult } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { classifyRunnerStartupFailure } from './runner-error-classification.ts';
import { logChunk } from './runner-io.ts';
import {
  runnerSimulatorSetFailureDetails,
  simulatorSetDestinationNotFoundMessage,
  xcodebuildDestinationArgs,
} from './runner-device-set.ts';
import {
  acquireRunnerXctestrunCacheLock,
  assertSafeDerivedCleanup,
  cleanRunnerDerivedArtifacts,
  cleanRunnerDerivedBeforeEvaluation,
  emitRunnerXctestrunDecision,
  emitRunnerXctestrunRebuildDecision,
  evaluateExistingXctestrun,
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDerivedPath,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
  requireCertifiedRunnerCacheArtifacts,
  writeRunnerCacheMetadataForArtifacts,
  type ExistingXctestrunState,
  type RunnerPhaseBudget,
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
} from './apple-runner-platform.ts';
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
  xctestrunPathSource: 'manifest' | 'build' | 'external';
  reason?: string;
};

export type ExternalXctestRunnerOptions = {
  iosXctestrunFile?: string;
  iosXctestDerivedDataPath?: string;
  iosXctestEnvDir?: string;
};

/** What the build phase reads: its budget, and where it logs. */
type RunnerXctestrunBuildOptions = {
  verbose?: boolean;
  logPath?: string;
  traceLogPath?: string;
  /**
   * The build phase's one budget, opened by whoever owns the build: the cache decision's
   * blocking toolchain probes and `xcodebuild` spend the same clock, and the owning
   * request cancels both (#2422).
   */
  budget?: RunnerPhaseBudget;
};

export async function ensureXctestrunArtifact(
  device: DeviceInfo,
  options: RunnerXctestrunBuildOptions & {
    forceRunnerXctestrunRebuild?: boolean;
  } & ExternalXctestRunnerOptions,
): Promise<RunnerXctestrunArtifact> {
  const external = resolveExternalXctestrunArtifact(options);
  if (external) return external;

  const projectRoot = findProjectRoot();
  const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(
    device,
    projectRoot,
    options.budget,
  );
  const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
  return await withKeyedLock(runnerXctestrunBuildLocks, derived, async () => {
    return await withProcessLock({
      acquire: () => acquireRunnerXctestrunCacheLock(derived),
      task: () =>
        ensureXctestrunUnderCacheLock({
          device,
          options,
          projectRoot,
          expectedCacheMetadata,
          derived,
          forceRebuild: options.forceRunnerXctestrunRebuild === true,
        }),
    });
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
  options: RunnerXctestrunBuildOptions;
  projectRoot: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
  derived: string;
  forceRebuild: boolean;
}): Promise<RunnerXctestrunArtifact> {
  const { device, options, projectRoot, expectedCacheMetadata, derived } = params;
  cleanRunnerDerivedBeforeEvaluation(derived, params.forceRebuild);
  const existing = await evaluateExistingXctestrun({
    derived,
    expectedCacheMetadata,
  });
  const cache = existing.reason === 'reuse_ready' ? 'exact' : 'miss';
  const reusable = await resolveReusableXctestrunArtifact({
    device,
    derived,
    expectedCacheMetadata,
    existing,
    cache,
  });
  if (reusable) return reusable;
  if (existing.reason !== 'reuse_ready') {
    emitRunnerXctestrunRebuildDecision(existing, derived);
  }
  // Nothing survived evaluation — a certified state that failed repair, or one the manifest
  // refuses — so the tree is discarded before the rebuild. A missing manifest is not ours to
  // delete: that directory is either a first build or one the caller laid out itself.
  if (existing.reason !== 'cache_metadata_missing') {
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
    xctestrunPathSource: 'manifest',
  };
}

async function buildXctestrunArtifact(params: {
  device: DeviceInfo;
  options: RunnerXctestrunBuildOptions;
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

  const buildTimeoutMs = requireRunnerPhaseRemainingMs(options.budget, 'runner_xctestrun_build');
  const buildStartedAt = Date.now();
  emitRequestProgress({
    type: 'command',
    status: 'progress',
    message: 'Building Apple runner...',
  });
  await buildRunnerXctestrun(device, projectPath, derived, options, buildTimeoutMs);
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
  // The manifest is written last so it certifies the bytes that actually run.
  await applyXctestRunnerAppIcon(builtProductPaths);
  requireCertifiedRunnerCacheArtifacts(
    writeRunnerCacheMetadataForArtifacts(derived, expectedCacheMetadata, built, builtProductPaths),
    derived,
  );
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
    requireCertifiedRunnerCacheArtifacts(
      writeRunnerCacheMetadataForArtifacts(
        derived,
        expectedCacheMetadata,
        existing.xctestrunPath,
        existing.productPaths,
      ),
      derived,
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
// evaluation as the ensure path (cache metadata + content-manifest validation),
// so a partial, restored, or tampered cache never reports as ready. Resolving
// the expected metadata stats the runner sources and reads tool versions
// (~100ms, cached per process) and the manifest digests the products (tens of
// ms) but never builds.
export async function hasCachedAppleRunnerArtifact(device: DeviceInfo): Promise<boolean> {
  try {
    const projectRoot = findProjectRoot();
    const expectedCacheMetadata = resolveExpectedRunnerCacheMetadata(device, projectRoot);
    const derived = resolveRunnerDerivedPath(device, expectedCacheMetadata);
    const existing = await evaluateExistingXctestrun({ derived, expectedCacheMetadata });
    return existing.reason === 'reuse_ready';
  } catch {
    return false;
  }
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

async function buildRunnerXctestrun(
  device: DeviceInfo,
  projectPath: string,
  derived: string,
  options: RunnerXctestrunBuildOptions,
  /** What {@link requireRunnerPhaseRemainingMs} left of the build phase, for the exec layer. */
  buildTimeoutMs: number | undefined,
): Promise<void> {
  const runnerBundleBuildSettings = resolveRunnerBundleBuildSettings(process.env);
  const signingBuildSettings = resolveRunnerSigningBuildSettings(
    process.env,
    device.kind === 'device',
    device,
  );
  const provisioningArgs = device.kind === 'device' ? ['-allowProvisioningUpdates'] : [];
  const performanceBuildSettings = resolveRunnerPerformanceBuildSettings();
  const archBuildSettings = resolveRunnerArchBuildSettings(process.env);
  const sandboxBuildArgs = resolveRunnerSandboxBuildArgs();
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
        ...xcodebuildDestinationArgs(device, resolveRunnerBuildDestination(device)),
        '-derivedDataPath',
        derived,
        ...performanceBuildSettings,
        ...archBuildSettings,
        ...sandboxBuildArgs,
        ...runnerBundleBuildSettings,
        ...provisioningArgs,
        ...signingBuildSettings,
      ],
      {
        detached: true,
        timeoutMs: buildTimeoutMs,
        signal: options.budget?.signal,
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
  } catch (error) {
    if (isRequestCanceledError(error)) throw error;
    const appErr =
      error instanceof AppError ? error : new AppError('COMMAND_FAILED', String(error));
    const simulatorSet = runnerSimulatorSetFailureDetails(device);
    // The reason and the hint beside it come from one classifier (#2680), so the reason a caller
    // switches on can never disagree with the advice it is handed.
    const { reason, hint, matched } = classifyRunnerStartupFailure(
      new AppError(appErr.code, appErr.message, { ...appErr.details, ...simulatorSet }),
    );
    const hostDeadlineHit = isCommandTimeoutError(appErr);
    // `startupRuleMatched` travels with the verdict: this wrapper buries the tool's text a level too
    // deep for the rows to read again, and whether a row spoke is not recoverable from the reason
    // alone (#2690 review). The device's own state is attached further out, by the startup catch that
    // can see this build and the launch after it.
    const message = 'xcodebuild build-for-testing failed';
    throw new AppError(
      'COMMAND_FAILED',
      reason === 'simulator_set_destination_not_found'
        ? simulatorSetDestinationNotFoundMessage(message, device, simulatorSet)
        : message,
      {
        reason,
        error: appErr.message,
        details: appErr.details,
        logPath: options.logPath,
        hint,
        startupRuleMatched: matched,
        startupHostDeadlineHit: hostDeadlineHit,
        ...simulatorSet,
      },
    );
  }
}
