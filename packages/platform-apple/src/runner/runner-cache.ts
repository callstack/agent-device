import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import {
  emitDiagnostic,
  readProcessStartTime,
  acquireProcessLock,
  withProcessLock,
  isEnvTruthy,
  findProjectRoot,
} from './host.ts';
import {
  RUNNER_CACHE_METADATA_FILE,
  comparableRunnerCacheMetadata,
  diffComparableRunnerCacheMetadata,
  stableJsonStringify,
  type RunnerCacheMetadataDifference,
  type RunnerXctestrunCacheMetadata,
} from './runner-cache-metadata.ts';
import type {
  RunnerCacheArtifactMismatch,
  RunnerCacheRefusal,
} from './runner-artifact-manifest.ts';
export {
  requireRunnerPhaseRemainingMs,
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerArchBuildSettings,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDerivedPath,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
  type RunnerPhaseBudget,
  type RunnerXctestrunCacheMetadata,
} from './runner-cache-metadata.ts';

const RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS = 10 * 60_000;
const RUNNER_XCTESTRUN_CACHE_LOCK_POLL_MS = 100;
const RUNNER_XCTESTRUN_CACHE_LOCK_OWNER_GRACE_MS = 5_000;

const badRunnerArtifactsForRun = new Set<string>();

export type RunnerXctestrunCacheKind = 'exact' | 'miss' | 'external';

export type ExistingXctestrunState =
  | {
      reason: 'reuse_ready';
      xctestrunPath: string;
      productPaths: string[];
    }
  | {
      reason: 'cache_metadata_missing' | 'artifact_manifest_missing';
      xctestrunPath: string | null;
      productPaths: string[];
    }
  | {
      reason: 'artifact_content_mismatch';
      xctestrunPath: string | null;
      productPaths: string[];
      /** The first entry whose bytes, kind, or mode disagree with the manifest. */
      mismatch: RunnerCacheArtifactMismatch;
    }
  | {
      reason: 'cache_metadata_mismatch';
      xctestrunPath: string | null;
      productPaths: string[];
      /** Which comparable keys differ, so a rebuild names its cause. */
      metadataDifferences: RunnerCacheMetadataDifference[];
    };

type RunnerXctestrunArtifactIdentity = {
  cache: RunnerXctestrunCacheKind;
  derived: string;
  xctestrunPath: string;
};

export function resolveRunnerCacheMetadataPath(derived: string): string {
  return path.join(derived, RUNNER_CACHE_METADATA_FILE);
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
  artifact: RunnerXctestrunArtifactIdentity,
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
  await withProcessLock({
    acquire: () => acquireRunnerXctestrunCacheLock(artifact.derived),
    task: async () => {
      emitRunnerXctestrunDecision('clean', 'bad_artifact', {
        derived: artifact.derived,
        xctestrunPath: artifact.xctestrunPath,
        reason,
      });
      assertSafeDerivedCleanup(artifact.derived);
      cleanRunnerDerivedArtifacts(artifact.derived);
    },
  });
}

export async function acquireRunnerXctestrunCacheLock(
  derived: string,
): Promise<() => Promise<void>> {
  return await acquireProcessLock({
    lockDirPath: resolveRunnerXctestrunCacheLockPath(derived),
    owner: {
      pid: process.pid,
      startTime: readProcessStartTime(process.pid),
      acquiredAtMs: Date.now(),
    },
    timeoutMs: RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS,
    pollMs: RUNNER_XCTESTRUN_CACHE_LOCK_POLL_MS,
    ownerGraceMs: RUNNER_XCTESTRUN_CACHE_LOCK_OWNER_GRACE_MS,
    description: 'iOS runner cache lock',
  });
}

function resolveRunnerXctestrunCacheLockPath(derived: string): string {
  return path.join(path.dirname(derived), `${path.basename(derived)}.lock`);
}

export function cleanRunnerDerivedBeforeEvaluation(derived: string, forceRebuild: boolean): void {
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

/**
 * Publishes cache metadata whose `artifacts` manifest digests the exact bytes of the `.xctestrun`
 * and every file and symlink under the referenced product paths, keyed relative to the cache root.
 * Reuse is authorized from this manifest alone.
 *
 * A tree the walk cannot describe is published without a manifest, which makes it a permanent
 * miss, and the refusal is returned so the caller can name it. Silently uncertifiable products
 * would otherwise cost a full rebuild on every launch with nothing to trace.
 */
export async function writeRunnerCacheMetadataForArtifacts(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata,
  xctestrunPath: string,
  productPaths: readonly string[],
): Promise<RunnerCacheRefusal | null> {
  const { buildRunnerCacheArtifactManifest } = await import('./runner-artifact-manifest.ts');
  const built = buildRunnerCacheArtifactManifest(derived, xctestrunPath, productPaths);
  writeRunnerCacheMetadata(
    derived,
    built.ok ? { ...metadata, artifacts: built.artifacts } : metadata,
  );
  if (built.ok) {
    return null;
  }
  emitRunnerXctestrunDecision('preserve', 'uncertifiable_products', {
    derived,
    xctestrunPath,
    ...(built.refusal ? { refusal: built.refusal } : {}),
  });
  return built.refusal;
}

/**
 * A cache tree a content manifest cannot certify is not safe to launch: nothing can prove those
 * bytes came from this build. Fails with the refusing entry rather than reporting a plain miss,
 * which would rebuild the same uncertifiable tree on every launch.
 */
export function requireCertifiedRunnerCacheArtifacts(
  refusal: RunnerCacheRefusal | null,
  derived: string,
): void {
  if (!refusal) {
    return;
  }
  throw new AppError(
    'COMMAND_FAILED',
    'The Apple runner products cannot be certified for cache reuse',
    {
      reason: 'runner_cache_uncertifiable',
      refusalReason: refusal.reason,
      refusingPath: refusal.path ?? derived,
      ...(refusal.reason === 'root_unusable' ? {} : { resolvesTo: refusal.target }),
      derived,
      hint: `Inspect ${refusal.path ?? derived} under ${derived}. A symlinked or unreadable product tree must be replaced; run pnpm build:xcuitest with a clean AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH.`,
    },
  );
}

export function cleanRunnerDerivedArtifacts(derived: string): void {
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

export function shouldDeleteRunnerDerivedRootEntry(entryName: string): boolean {
  return RUNNER_ROOT_TRANSIENT_ENTRY_NAMES.has(entryName);
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

type RunnerCacheMetadataEvaluation =
  | { ok: true; metadata: RunnerXctestrunCacheMetadata }
  | { ok: false; reason: 'cache_metadata_missing' }
  | {
      ok: false;
      reason: 'cache_metadata_mismatch';
      differences: RunnerCacheMetadataDifference[];
    };

function evaluateRunnerCacheMetadata(
  derived: string,
  expected: RunnerXctestrunCacheMetadata,
): RunnerCacheMetadataEvaluation {
  const actual = readRunnerCacheMetadata(derived);
  if (!actual) {
    return { ok: false, reason: 'cache_metadata_missing' };
  }
  if (
    stableJsonStringify(comparableRunnerCacheMetadata(actual)) !==
    stableJsonStringify(comparableRunnerCacheMetadata(expected))
  ) {
    return {
      ok: false,
      reason: 'cache_metadata_mismatch',
      differences: diffComparableRunnerCacheMetadata(expected, actual),
    };
  }
  return { ok: true, metadata: actual };
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

export async function evaluateExistingXctestrun(options: {
  derived: string;
  expectedCacheMetadata: RunnerXctestrunCacheMetadata;
}): Promise<ExistingXctestrunState> {
  const cacheMetadata = evaluateRunnerCacheMetadata(options.derived, options.expectedCacheMetadata);
  if (!cacheMetadata.ok) {
    return cacheMetadata.reason === 'cache_metadata_mismatch'
      ? {
          reason: cacheMetadata.reason,
          xctestrunPath: null,
          productPaths: [],
          metadataDifferences: cacheMetadata.differences,
        }
      : { reason: cacheMetadata.reason, xctestrunPath: null, productPaths: [] };
  }
  const { validateRunnerCacheArtifactManifest } = await import('./runner-artifact-manifest.ts');
  const artifacts = validateRunnerCacheArtifactManifest(options.derived, cacheMetadata.metadata);
  if (!artifacts.ok) {
    return artifacts.mismatch
      ? {
          reason: 'artifact_content_mismatch',
          xctestrunPath: null,
          productPaths: [],
          mismatch: artifacts.mismatch,
        }
      : { reason: 'artifact_manifest_missing', xctestrunPath: null, productPaths: [] };
  }
  return {
    reason: 'reuse_ready',
    xctestrunPath: artifacts.xctestrunPath,
    productPaths: artifacts.productPaths,
  };
}

/**
 * Reports why a cache state cannot be reused, naming the differing keys when the
 * cause is a metadata mismatch and the failing entry when the cause is content.
 */
export function emitRunnerXctestrunRebuildDecision(
  existing: Exclude<ExistingXctestrunState, { reason: 'reuse_ready' }>,
  derived: string,
): void {
  emitRunnerXctestrunDecision('rebuild', existing.reason, {
    derived,
    ...(existing.reason === 'cache_metadata_mismatch'
      ? { metadataDifferences: existing.metadataDifferences }
      : {}),
    ...(existing.reason === 'artifact_content_mismatch' ? { mismatch: existing.mismatch } : {}),
  });
}

export function emitRunnerXctestrunDecision(
  action: 'clean' | 'reuse' | 'rebuild' | 'build' | 'preserve',
  reason:
    | 'forced_clean'
    | 'artifact_manifest_missing'
    | 'artifact_content_mismatch'
    | 'cache_metadata_missing'
    | 'cache_metadata_mismatch'
    | 'repair_failed'
    | 'reuse_ready'
    | 'forced_rebuild'
    | 'bad_artifact'
    | 'built_new'
    | 'external_xctestrun'
    | 'external_bad_artifact'
    | 'uncertifiable_products',
  data: Record<string, unknown>,
): void {
  emitDiagnostic({
    level: action === 'rebuild' || action === 'preserve' ? 'warn' : 'info',
    phase: 'runner_xctestrun_cache',
    data: {
      action,
      reason,
      ...data,
    },
  });
}
