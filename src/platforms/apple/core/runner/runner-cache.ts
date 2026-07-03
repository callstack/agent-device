import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../../../../kernel/errors.ts';
import { emitDiagnostic } from '../../../../utils/diagnostics.ts';
import { readProcessStartTime } from '../../../../utils/process-identity.ts';
import { acquireProcessLock, type ProcessLockOwner } from '../../../../utils/process-lock.ts';
import { isEnvTruthy } from '../../../../utils/retry.ts';
import { findProjectRoot } from '../../../../utils/version.ts';
import {
  RUNNER_CACHE_METADATA_FILE,
  comparableRunnerCacheMetadata,
  stableJsonStringify,
  type RunnerXctestrunCacheArtifacts,
  type RunnerXctestrunCacheMetadata,
  type RunnerXctestrunCacheProductArtifact,
} from './runner-cache-metadata.ts';
export {
  resolveExpectedRunnerCacheMetadata,
  resolveRunnerBundleBuildSettings,
  resolveRunnerDerivedPath,
  resolveRunnerMaxConcurrentDestinationsFlag,
  resolveRunnerPerformanceBuildSettings,
  resolveRunnerSandboxBuildArgs,
  resolveRunnerSigningBuildSettings,
  type RunnerXctestrunCacheMetadata,
} from './runner-cache-metadata.ts';

const RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS = 10 * 60_000;
const RUNNER_XCTESTRUN_CACHE_LOCK_POLL_MS = 100;
const RUNNER_XCTESTRUN_CACHE_LOCK_OWNER_GRACE_MS = 5_000;

const badRunnerArtifactsForRun = new Set<string>();

export type RunnerXctestrunCacheKind = 'exact' | 'restore-key' | 'miss' | 'external';

export type ExistingXctestrunState =
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

export async function acquireRunnerXctestrunCacheLock(
  derived: string,
): Promise<() => Promise<void>> {
  return await acquireRunnerCacheProcessLock({
    lockDirPath: resolveRunnerXctestrunCacheLockPath(derived),
    owner: {
      pid: process.pid,
      startTime: readProcessStartTime(process.pid),
      acquiredAtMs: Date.now(),
    },
    description: 'iOS runner cache lock',
  });
}

async function acquireRunnerCacheProcessLock(params: {
  lockDirPath: string;
  owner: ProcessLockOwner;
  timeoutMs?: number;
  description?: string;
}): Promise<() => Promise<void>> {
  return await acquireProcessLock({
    lockDirPath: params.lockDirPath,
    owner: params.owner,
    timeoutMs: params.timeoutMs ?? RUNNER_XCTESTRUN_CACHE_LOCK_TIMEOUT_MS,
    pollMs: RUNNER_XCTESTRUN_CACHE_LOCK_POLL_MS,
    ownerGraceMs: RUNNER_XCTESTRUN_CACHE_LOCK_OWNER_GRACE_MS,
    description: params.description ?? 'iOS runner cache lock',
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

export function writeRunnerCacheMetadataForArtifacts(
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

// fallow-ignore-next-line complexity
export async function evaluateExistingXctestrun(options: {
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

export function emitRunnerXctestrunDecision(
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
