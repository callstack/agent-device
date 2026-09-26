import crypto from 'node:crypto';
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
  type RunnerCacheArtifactEntry,
  type RunnerCacheArtifactFileEntry,
  type RunnerCacheArtifactSymlinkEntry,
  type RunnerCacheMetadataDifference,
  type RunnerXctestrunCacheArtifacts,
  type RunnerXctestrunCacheMetadata,
} from './runner-cache-metadata.ts';
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

/** Ceiling on one digested artifact file. Runner products are tens of MB at most. */
const RUNNER_CACHE_ARTIFACT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const RUNNER_CACHE_ARTIFACT_MODE_BITS = 0o7777;

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

/** Why a content manifest does not certify the products on disk. */
export type RunnerCacheArtifactMismatch =
  | { path: string; reason: 'missing' }
  | { path: string; reason: 'kind_changed' }
  | { path: string; reason: 'size_changed'; expected: number; actual: number }
  | { path: string; reason: 'digest_mismatch' }
  | { path: string; reason: 'mode_changed'; expected: number; actual: number }
  | { path: string; reason: 'symlink_target_changed'; expected: string; actual: string }
  | { path: string; reason: 'escaping_symlink'; target: string }
  | { path: string; reason: 'undeclared_entry' }
  | { path: string; reason: 'file_too_large'; size: number };

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
 * Writes cache metadata whose `artifacts` manifest digests the exact bytes of the
 * `.xctestrun` and every file and symlink under the referenced product paths, keyed
 * relative to the cache root. Reuse is authorized from this manifest alone.
 */
export function writeRunnerCacheMetadataForArtifacts(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata,
  xctestrunPath: string,
  productPaths: readonly string[],
): void {
  const artifacts = buildRunnerCacheArtifacts(derived, xctestrunPath, productPaths);
  writeRunnerCacheMetadata(derived, artifacts ? { ...metadata, artifacts } : metadata);
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

function buildRunnerCacheArtifacts(
  cacheRoot: string,
  xctestrunPath: string,
  productPaths: readonly string[],
): RunnerXctestrunCacheArtifacts | null {
  if (productPaths.length === 0) {
    return null;
  }
  if (
    !isPathInsideDirectory(xctestrunPath, cacheRoot) ||
    !productPaths.every((productPath) => isPathInsideDirectory(productPath, cacheRoot))
  ) {
    return null;
  }
  const xctestrunDigest = digestFile(xctestrunPath);
  if (!xctestrunDigest) {
    return null;
  }
  const entries: RunnerCacheArtifactEntry[] = [];
  for (const productPath of dedupeNestedPaths(productPaths)) {
    const collected = collectRunnerCacheArtifactEntries(cacheRoot, productPath);
    if (!collected) {
      return null;
    }
    entries.push(...collected);
  }
  if (entries.length === 0) {
    return null;
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    xctestrunPath,
    xctestrunSize: fs.statSync(xctestrunPath).size,
    xctestrunDigest: xctestrunDigest.digest,
    productPaths: [...productPaths],
    entries,
  };
}

/** Drop paths whose ancestor is already walked, so no subtree is collected twice. */
function dedupeNestedPaths(productPaths: readonly string[]): string[] {
  const sorted = [...new Set(productPaths.map((target) => path.resolve(target)))].sort();
  const kept: string[] = [];
  for (const candidate of sorted) {
    if (kept.some((keptPath) => isPathInsideDirectory(candidate, keptPath))) continue;
    kept.push(candidate);
  }
  return kept;
}

/**
 * One leaf of a cached product: where it lives in the manifest, where it lives on disk, and
 * what `lstat` says about it. The writer digests these; the reader compares them to the manifest.
 */
type RunnerCacheArtifactLeaf = {
  relativePath: string;
  fullPath: string;
  stat: fs.Stats;
};

/**
 * The single traversal both cache sides share: every file and symlink under one product root,
 * in manifest-relative form. A kind the manifest cannot represent — a socket, a device, an
 * escaping symlink — or an unreadable directory makes the whole product uncertifiable.
 */
// fallow-ignore-next-line complexity
function walkRunnerCacheArtifactLeaves(
  cacheRoot: string,
  root: string,
): RunnerCacheArtifactLeaf[] | null {
  const leaves: RunnerCacheArtifactLeaf[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      return null;
    }
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const relativePath = toManifestPath(cacheRoot, fullPath);
      if (relativePath === null) {
        return null;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        return null;
      }
      if (!isManifestDescribingEntry(stat)) {
        return null;
      }
      if (!stat.isDirectory()) {
        leaves.push({ relativePath, fullPath, stat });
      } else {
        stack.push(fullPath);
      }
    }
  }
  return leaves;
}

/**
 * Whether one directory entry is something a content manifest can describe at all: a directory
 * to descend into, a regular file, or a symlink. A socket or a device makes the product
 * uncertifiable. Whether a symlink stays inside the tree is decided per side: the writer
 * refuses to certify one that escapes, the reader reports which entry started escaping.
 */
function isManifestDescribingEntry(stat: fs.Stats): boolean {
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

function collectRunnerCacheArtifactEntries(
  cacheRoot: string,
  root: string,
): RunnerCacheArtifactEntry[] | null {
  const leaves = walkRunnerCacheArtifactLeaves(cacheRoot, root);
  if (!leaves) {
    return null;
  }
  const entries: RunnerCacheArtifactEntry[] = [];
  for (const leaf of leaves) {
    if (leaf.stat.isSymbolicLink()) {
      const target = fs.readlinkSync(leaf.fullPath);
      if (!isSymlinkContained(cacheRoot, leaf.fullPath, target)) {
        return null;
      }
      entries.push({ path: leaf.relativePath, symlink: target });
      continue;
    }
    if (leaf.stat.size > RUNNER_CACHE_ARTIFACT_MAX_FILE_BYTES) {
      return null;
    }
    const digest = digestFile(leaf.fullPath);
    if (!digest) {
      return null;
    }
    entries.push({
      path: leaf.relativePath,
      size: digest.size,
      mode: leaf.stat.mode & RUNNER_CACHE_ARTIFACT_MODE_BITS,
      digest: digest.digest,
    });
  }
  return entries;
}

function toManifestPath(cacheRoot: string, fullPath: string): string | null {
  const relativePath = path.relative(cacheRoot, fullPath);
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath;
}

function isSymlinkContained(cacheRoot: string, linkPath: string, target: string): boolean {
  if (path.isAbsolute(target)) {
    return isPathInsideDirectory(target, cacheRoot);
  }
  return isPathInsideDirectory(path.resolve(path.dirname(linkPath), target), cacheRoot);
}

function digestFile(filePath: string): { digest: string; size: number } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > RUNNER_CACHE_ARTIFACT_MAX_FILE_BYTES) {
      return null;
    }
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return { digest: hash.digest('hex'), size: stat.size };
  } catch {
    return null;
  }
}

type RunnerCacheArtifactValidation =
  | { ok: true; xctestrunPath: string; productPaths: string[] }
  | { ok: false; mismatch: RunnerCacheArtifactMismatch | null };

function readValidatedRunnerCacheArtifacts(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata,
): RunnerCacheArtifactValidation {
  const artifacts = metadata.artifacts;
  if (!isRunnerCacheArtifacts(artifacts)) {
    return { ok: false, mismatch: null };
  }
  if (
    !isPathInsideDirectory(artifacts.xctestrunPath, derived) ||
    !artifacts.productPaths.every((productPath) => isPathInsideDirectory(productPath, derived))
  ) {
    return { ok: false, mismatch: null };
  }
  const declared = new Map(artifacts.entries.map((entry) => [entry.path, entry]));
  const xctestrunMismatch = validateManifestedFile(
    artifacts.xctestrunPath,
    artifacts.xctestrunSize,
    artifacts.xctestrunDigest,
  );
  if (xctestrunMismatch) {
    return { ok: false, mismatch: xctestrunMismatch };
  }
  for (const productPath of dedupeNestedPaths(artifacts.productPaths)) {
    const mismatch = validateProductAgainstManifest(derived, productPath, declared);
    if (mismatch) {
      return { ok: false, mismatch };
    }
  }
  // Anything still declared never came back from the walk.
  const unlisted = declared.keys().next();
  if (!unlisted.done) {
    return { ok: false, mismatch: { path: unlisted.value, reason: 'missing' } };
  }
  return {
    ok: true,
    xctestrunPath: artifacts.xctestrunPath,
    productPaths: [...artifacts.productPaths],
  };
}

/**
 * Walks one product with the same traversal the writer used and removes each leaf it can
 * certify from `declared`. A leaf on disk that the manifest never names is unaccounted for.
 */
function validateProductAgainstManifest(
  derived: string,
  productPath: string,
  declared: Map<string, RunnerCacheArtifactEntry>,
): RunnerCacheArtifactMismatch | null {
  const leaves = walkRunnerCacheArtifactLeaves(derived, productPath);
  if (!leaves) {
    return { path: productPath, reason: 'missing' };
  }
  for (const leaf of leaves) {
    const entry = declared.get(leaf.relativePath);
    if (!entry) {
      return { path: leaf.relativePath, reason: 'undeclared_entry' };
    }
    const mismatch = validateManifestEntry(derived, leaf.fullPath, leaf.relativePath, entry);
    if (mismatch) {
      return mismatch;
    }
    declared.delete(leaf.relativePath);
  }
  return null;
}

function validateManifestEntry(
  cacheRoot: string,
  fullPath: string,
  relativePath: string,
  entry: RunnerCacheArtifactEntry,
): RunnerCacheArtifactMismatch | null {
  if ('symlink' in entry) {
    let actual: string;
    try {
      actual = fs.readlinkSync(fullPath);
    } catch {
      return { path: relativePath, reason: 'missing' };
    }
    if (actual !== entry.symlink) {
      return {
        path: relativePath,
        reason: 'symlink_target_changed',
        expected: entry.symlink,
        actual,
      };
    }
    if (!isSymlinkContained(cacheRoot, fullPath, actual)) {
      return { path: relativePath, reason: 'escaping_symlink', target: actual };
    }
    return null;
  }
  return validateManifestedFile(fullPath, entry.size, entry.digest, entry.mode, relativePath);
}

function validateManifestedFile(
  fullPath: string,
  expectedSize: number,
  expectedDigest: string,
  expectedMode?: number,
  relativePath?: string,
): RunnerCacheArtifactMismatch | null {
  const reportedPath = relativePath ?? fullPath;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(fullPath);
  } catch {
    return { path: reportedPath, reason: 'missing' };
  }
  if (!stat.isFile()) {
    return { path: reportedPath, reason: 'kind_changed' };
  }
  if (stat.size !== expectedSize) {
    return {
      path: reportedPath,
      reason: 'size_changed',
      expected: expectedSize,
      actual: stat.size,
    };
  }
  if (
    expectedMode !== undefined &&
    (stat.mode & RUNNER_CACHE_ARTIFACT_MODE_BITS) !== expectedMode
  ) {
    return {
      path: reportedPath,
      reason: 'mode_changed',
      expected: expectedMode,
      actual: stat.mode & RUNNER_CACHE_ARTIFACT_MODE_BITS,
    };
  }
  const digested = digestFile(fullPath);
  if (!digested) {
    return { path: reportedPath, reason: 'file_too_large', size: stat.size };
  }
  if (digested.digest !== expectedDigest) {
    return { path: reportedPath, reason: 'digest_mismatch' };
  }
  return null;
}

function isRunnerCacheArtifacts(value: unknown): value is RunnerXctestrunCacheArtifacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const artifacts = value as Partial<RunnerXctestrunCacheArtifacts>;
  return (
    typeof artifacts.xctestrunPath === 'string' &&
    isNonNegativeInteger(artifacts.xctestrunSize) &&
    typeof artifacts.xctestrunDigest === 'string' &&
    isNonEmptyStringArray(artifacts.productPaths) &&
    isNonEmptyArray(artifacts.entries) &&
    artifacts.entries.every(isRunnerCacheArtifactEntry)
  );
}

function isRunnerCacheArtifactEntry(value: unknown): value is RunnerCacheArtifactEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<RunnerCacheArtifactFileEntry> &
    Partial<RunnerCacheArtifactSymlinkEntry>;
  if (typeof entry.path !== 'string' || !isManifestRelativePath(entry.path)) {
    return false;
  }
  if (typeof entry.symlink === 'string') {
    return entry.digest === undefined;
  }
  return (
    typeof entry.digest === 'string' &&
    isNonNegativeInteger(entry.size) &&
    typeof entry.mode === 'number'
  );
}

/** A manifest path must stay inside the cache root it was written under. */
function isManifestRelativePath(relativePath: string): boolean {
  return (
    !relativePath.startsWith('/') &&
    !relativePath.startsWith('..') &&
    !path.isAbsolute(relativePath)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isNonEmptyArray(value) && value.every((item) => typeof item === 'string');
}

function isNonEmptyArray<Item>(value: unknown): value is Item[] {
  return Array.isArray(value) && value.length > 0;
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
  const artifacts = readValidatedRunnerCacheArtifacts(options.derived, cacheMetadata.metadata);
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
