import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  RunnerCacheArtifactEntry,
  RunnerCacheArtifactFileEntry,
  RunnerCacheArtifactSymlinkEntry,
  RunnerXctestrunCacheArtifacts,
  RunnerXctestrunCacheMetadata,
} from './runner-cache-metadata.ts';

/** Ceiling on one digested artifact file. Runner products are tens of MB at most. */
const RUNNER_CACHE_ARTIFACT_MAX_FILE_BYTES = 128 * 1024 * 1024;
const RUNNER_CACHE_ARTIFACT_MODE_BITS = 0o7777;

/**
 * Whether a cached runner product tree may be reused. One traversal answers this for both sides:
 * the writer digests a tree to publish a content manifest, and the reader walks the same tree to
 * certify it against the manifest it published. A tree either side cannot fully describe is not
 * reusable, because nothing then proves the bytes on disk are the bytes a build produced.
 */

/** Why a content manifest does not certify the products on disk. */
export type RunnerCacheArtifactMismatch =
  | { path: string; reason: 'missing' }
  | { path: string; reason: 'kind_changed' }
  | { path: string; reason: 'size_changed'; expected: number; actual: number }
  | { path: string; reason: 'digest_mismatch' }
  | { path: string; reason: 'mode_changed'; expected: number; actual: number }
  | { path: string; reason: 'symlink_target_changed'; expected: string; actual: string }
  /** A symlinked entry whose target resolves outside every product the manifest covers. */
  | { path: string; reason: 'symlink_escapes_cache'; target: string }
  /** A product root that is, or sits under, a symlink leading outside the cache root. */
  | { path: string; reason: 'root_escapes_cache'; target: string }
  /** A root or entry the manifest cannot describe: unreadable, or an exotic entry kind. */
  | { path: string; reason: 'root_unusable' }
  | { path: string; reason: 'undeclared_entry' }
  | { path: string; reason: 'file_too_large'; size: number };

/**
 * Why a tree could not carry a content manifest, and so cannot be reused. A symlinked root or a
 * symlinked entry names where its bytes actually resolve; `root_unusable` covers what no manifest
 * can hold — an unreadable directory, an entry kind with no manifest form, an oversized file — and
 * names the refusing entry when the walk reached one.
 * Reported by {@link writeRunnerCacheMetadataForArtifacts}.
 */
export type RunnerCacheRefusal =
  | { reason: 'root_escapes_cache'; path: string; target: string }
  | { reason: 'symlink_escapes_cache'; path: string; target: string }
  | { reason: 'root_unusable'; path?: string };

type RunnerCacheArtifactWrite =
  | { ok: true; artifacts: RunnerXctestrunCacheArtifacts }
  | { ok: false; refusal: RunnerCacheRefusal };

/**
 * Digests a freshly built product tree into the manifest its cache entry will carry, or names why
 * the tree cannot carry one.
 */
export function buildRunnerCacheArtifactManifest(
  cacheRoot: string,
  xctestrunPath: string,
  productPaths: readonly string[],
): RunnerCacheArtifactWrite {
  const canonicalCacheRoot = resolveRealPath(cacheRoot);
  if (canonicalCacheRoot === null) {
    return { ok: false, refusal: { reason: 'root_unusable', path: cacheRoot } };
  }
  const xctestrun = digestXctestrun(cacheRoot, xctestrunPath, canonicalCacheRoot);
  if ('reason' in xctestrun) {
    return { ok: false, refusal: xctestrun };
  }
  const walked = resolveWalkedRoots(productPaths, cacheRoot, canonicalCacheRoot);
  if (!walked.ok) {
    return { ok: false, refusal: walked.refusal };
  }
  const entries: RunnerCacheArtifactEntry[] = [];
  for (const walkedRoot of walked.roots) {
    const collected = collectRunnerCacheArtifactEntries(
      canonicalCacheRoot,
      walkedRoot,
      walked.roots,
    );
    if (!collected.ok) {
      return { ok: false, refusal: collected.refusal };
    }
    entries.push(...collected.entries);
  }
  if (entries.length === 0) {
    return { ok: false, refusal: { reason: 'root_unusable', path: productPaths.join(', ') } };
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    ok: true,
    artifacts: {
      xctestrunPath,
      xctestrunSize: xctestrun.size,
      xctestrunDigest: xctestrun.digest,
      productPaths: [...productPaths],
      entries,
    },
  };
}

/**
 * The `.xctestrun` the manifest will certify: a regular file, not a symlink, whose bytes resolve
 * to inside the cache. A symlink here would make the manifest name one file while its digest
 * described another.
 */
function digestXctestrun(
  cacheRoot: string,
  xctestrunPath: string,
  canonicalCacheRoot: string,
): { digest: string; size: number } | RunnerCacheRefusal {
  const relativePath = toManifestPath(cacheRoot, xctestrunPath) ?? xctestrunPath;
  const resolved = resolveRealPath(xctestrunPath);
  if (resolved === null) {
    return { reason: 'root_unusable', path: relativePath };
  }
  if (!isPathInsideDirectory(resolved, canonicalCacheRoot)) {
    return { reason: 'root_escapes_cache', path: relativePath, target: resolved };
  }
  // The manifest names a regular file at this exact path; the reader lstats it and calls a
  // symlink a kind change. Certifying an in-cache link here would publish a manifest the reader
  // refuses at first sight, i.e. a rebuild on every launch.
  if (!isRegularFile(xctestrunPath)) {
    return { reason: 'root_unusable', path: relativePath };
  }
  const digested = digestFile(xctestrunPath);
  return digested ?? { reason: 'root_unusable', path: relativePath };
}

function isRegularFile(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** The product roots a manifest covers, or why none of them can be walked. */
type RunnerCacheWalkedRoots =
  | { ok: true; roots: string[] }
  | { ok: false; refusal: RunnerCacheRefusal };

/**
 * The product roots this manifest will cover, each resolved through the filesystem and required
 * to land inside the cache root as the filesystem resolves it. A root that is a symlink, or sits
 * under one that leaves the cache, is refused here rather than walked: its manifest-relative
 * names would describe a tree the cache does not own, and re-pointing the symlink would swap
 * those bytes without any manifest entry noticing.
 */
function resolveWalkedRoots(
  productPaths: readonly string[],
  cacheRoot: string,
  canonicalCacheRoot: string,
): RunnerCacheWalkedRoots {
  const roots: string[] = [];
  for (const productPath of dedupeNestedPaths(productPaths)) {
    const resolvedRoot = resolveRealPath(productPath);
    if (resolvedRoot === null) {
      return { ok: false, refusal: unusableRootRefusal(cacheRoot, productPath) };
    }
    if (!isPathInsideDirectory(resolvedRoot, canonicalCacheRoot)) {
      return {
        ok: false,
        refusal: {
          reason: 'root_escapes_cache',
          path: toManifestPath(cacheRoot, productPath) ?? productPath,
          target: resolvedRoot,
        },
      };
    }
    // `isPathInsideDirectory` is strict, so an alias resolving onto a root already walked -- a
    // direct path beside an in-cache symlink to the same bundle -- needs its own equality test.
    // Without it the leaves would be collected twice and the reader's walk would delete them
    // under the first root and call the second root's copies undeclared.
    if (
      !roots.some(
        (keptRoot) => resolvedRoot === keptRoot || isPathInsideDirectory(resolvedRoot, keptRoot),
      )
    ) {
      roots.push(resolvedRoot);
    }
  }
  if (roots.length > 0) {
    return { ok: true, roots };
  }
  return { ok: false, refusal: { reason: 'root_unusable', path: productPaths.join(', ') } };
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

type RunnerCacheLeafWalk =
  | { ok: true; leaves: RunnerCacheArtifactLeaf[] }
  | { ok: false; refusal: RunnerCacheRefusal };

/**
 * The single traversal both cache sides share: every file and symlink under one product root, in
 * manifest-relative form, where `walkedRoots` are all the roots the manifest covers.
 *
 * A symlink is contained only when its target resolves, through the filesystem rather than
 * lexically, inside one of those roots. That is what makes the target's bytes certified: the walk
 * of that root digests them. A symlink pointing anywhere else — outside the cache, or into a
 * directory of it that no root covers — leaves the product uncertifiable, as does a kind the
 * manifest cannot represent (a socket, a device) or an unreadable directory.
 */
// fallow-ignore-next-line complexity
function walkRunnerCacheArtifactLeaves(
  cacheRoot: string,
  root: string,
  walkedRoots: readonly string[],
): RunnerCacheLeafWalk {
  const leaves: RunnerCacheArtifactLeaf[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(directory);
    } catch {
      const relativePath = toManifestPath(cacheRoot, directory);
      return { ok: false, refusal: { reason: 'root_unusable', path: relativePath ?? undefined } };
    }
    for (const name of names) {
      const fullPath = path.join(directory, name);
      const relativePath = toManifestPath(cacheRoot, fullPath);
      if (relativePath === null) {
        // Only a root that escaped the cache can produce this, and the caller checked the roots.
        return { ok: false, refusal: { reason: 'root_unusable', path: fullPath } };
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        return { ok: false, refusal: { reason: 'root_unusable', path: relativePath } };
      }
      if (!isManifestDescribingEntry(stat)) {
        return { ok: false, refusal: { reason: 'root_unusable', path: relativePath } };
      }
      if (stat.isSymbolicLink()) {
        const target = readContainedSymlinkTarget(fullPath, walkedRoots);
        if (target === null) {
          return {
            ok: false,
            refusal: {
              reason: 'symlink_escapes_cache',
              path: relativePath,
              target: readSymlinkTarget(fullPath) ?? '(unreadable)',
            },
          };
        }
      }
      if (!stat.isDirectory()) {
        leaves.push({ relativePath, fullPath, stat });
      } else {
        stack.push(fullPath);
      }
    }
  }
  return { ok: true, leaves };
}

/**
 * A symlink's raw target, but only when it resolves inside one of `walkedRoots`. A dangling target
 * is judged where it would land, so a link carried outside by its own parent chain is refused.
 */
function readContainedSymlinkTarget(
  linkPath: string,
  walkedRoots: readonly string[],
): string | null {
  const target = readSymlinkTarget(linkPath);
  if (target === null) {
    return null;
  }
  const resolvedTarget = resolveSymlinkTarget(linkPath, target);
  if (resolvedTarget === null) {
    return null;
  }
  return walkedRoots.some((walkedRoot) => isPathInsideDirectory(resolvedTarget, walkedRoot))
    ? target
    : null;
}

/** A symlink's raw target, or null when the link cannot be read. */
function readSymlinkTarget(linkPath: string): string | null {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

function resolveSymlinkTarget(linkPath: string, target: string): string | null {
  const resolvedParent = resolveRealPath(path.dirname(linkPath));
  if (resolvedParent === null) {
    return null;
  }
  const anchoredPath = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(resolvedParent, target);
  return resolveRealPath(anchoredPath) ?? anchoredPath;
}

type RunnerCacheEntryCollection =
  | { ok: true; entries: RunnerCacheArtifactEntry[] }
  | { ok: false; refusal: RunnerCacheRefusal };

/**
 * Whether one directory entry is something a content manifest can describe at all: a directory to
 * descend into, a regular file, or a symlink. A socket or a device makes a product uncertifiable.
 */
function isManifestDescribingEntry(stat: fs.Stats): boolean {
  return stat.isDirectory() || stat.isFile() || stat.isSymbolicLink();
}

function collectRunnerCacheArtifactEntries(
  cacheRoot: string,
  root: string,
  walkedRoots: readonly string[],
): RunnerCacheEntryCollection {
  const walk = walkRunnerCacheArtifactLeaves(cacheRoot, root, walkedRoots);
  if (!walk.ok) {
    return { ok: false, refusal: walk.refusal };
  }
  const entries: RunnerCacheArtifactEntry[] = [];
  for (const leaf of walk.leaves) {
    if (leaf.stat.isSymbolicLink()) {
      const target = readSymlinkTarget(leaf.fullPath);
      if (target === null) {
        return { ok: false, refusal: { reason: 'root_unusable', path: leaf.relativePath } };
      }
      entries.push({ path: leaf.relativePath, symlink: target });
      continue;
    }
    if (leaf.stat.size > RUNNER_CACHE_ARTIFACT_MAX_FILE_BYTES) {
      return { ok: false, refusal: { reason: 'root_unusable', path: leaf.relativePath } };
    }
    const digest = digestFile(leaf.fullPath);
    if (!digest) {
      return { ok: false, refusal: { reason: 'root_unusable', path: leaf.relativePath } };
    }
    entries.push({
      path: leaf.relativePath,
      size: digest.size,
      mode: leaf.stat.mode & RUNNER_CACHE_ARTIFACT_MODE_BITS,
      digest: digest.digest,
    });
  }
  return { ok: true, entries };
}

function toManifestPath(cacheRoot: string, fullPath: string): string | null {
  const relativePath = path.relative(path.resolve(cacheRoot), path.resolve(fullPath));
  if (relativePath === '' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath;
}

function resolveRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
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

/**
 * Checks a cache root's manifest against the tree on disk: the `.xctestrun` and every product the
 * manifest names, byte for byte, inside the roots the manifest itself claims.
 */
export function validateRunnerCacheArtifactManifest(
  derived: string,
  metadata: RunnerXctestrunCacheMetadata,
): RunnerCacheArtifactValidation {
  const artifacts = metadata.artifacts;
  const canonicalCacheRoot = artifacts ? resolveRealPath(derived) : null;
  if (!artifacts || !isRunnerCacheArtifacts(artifacts) || canonicalCacheRoot === null) {
    return { ok: false, mismatch: null };
  }
  if (!isPathInsideDirectory(artifacts.xctestrunPath, derived)) {
    return { ok: false, mismatch: null };
  }
  const xctestrunMismatch = validateManifestedXctestrun(artifacts, canonicalCacheRoot);
  if (xctestrunMismatch) {
    return { ok: false, mismatch: xctestrunMismatch };
  }
  const productMismatch = validateManifestedProducts(
    artifacts,
    canonicalCacheRoot,
    resolveWalkedRoots(artifacts.productPaths, derived, canonicalCacheRoot),
  );
  if (productMismatch) {
    return { ok: false, mismatch: productMismatch };
  }
  return {
    ok: true,
    xctestrunPath: artifacts.xctestrunPath,
    productPaths: [...artifacts.productPaths],
  };
}

/**
 * Walks each product root and certifies its leaves against the manifest. An entry the manifest
 * declares but the walks never returned never existed here, and one the walks returned that the
 * manifest never names is a byte nobody accounted for.
 */
function validateManifestedProducts(
  artifacts: RunnerXctestrunCacheArtifacts,
  canonicalCacheRoot: string,
  walked: RunnerCacheWalkedRoots,
): RunnerCacheArtifactMismatch | null {
  if (!walked.ok) {
    return toWalkRefusal(walked.refusal);
  }
  const declared = new Map(artifacts.entries.map((entry) => [entry.path, entry]));
  for (const walkedRoot of walked.roots) {
    const mismatch = validateProductAgainstManifest(
      canonicalCacheRoot,
      walkedRoot,
      walked.roots,
      declared,
    );
    if (mismatch) {
      return mismatch;
    }
  }
  const unlisted = declared.keys().next();
  return unlisted.done ? null : { path: unlisted.value, reason: 'missing' };
}

/**
 * The `.xctestrun` as it sits now: a regular file whose bytes resolve to inside the cache root,
 * matching the digest the manifest holds. A manifest path swapped for a symlink elsewhere would
 * otherwise be digested from outside the cache.
 */
function validateManifestedXctestrun(
  artifacts: RunnerXctestrunCacheArtifacts,
  canonicalCacheRoot: string,
): RunnerCacheArtifactMismatch | null {
  const mismatch = validateManifestedFile(
    artifacts.xctestrunPath,
    artifacts.xctestrunSize,
    artifacts.xctestrunDigest,
  );
  if (mismatch) {
    return mismatch;
  }
  const resolved = resolveRealPath(artifacts.xctestrunPath);
  return resolved !== null && isPathInsideDirectory(resolved, canonicalCacheRoot)
    ? null
    : { path: artifacts.xctestrunPath, reason: 'root_escapes_cache', target: resolved ?? '(?)' };
}

/** Widens a walk refusal into the reason a reuse decision reports. */
function toWalkRefusal(refusal: RunnerCacheRefusal): RunnerCacheArtifactMismatch {
  if (refusal.reason === 'root_unusable') {
    return { path: refusal.path ?? '(cache root)', reason: 'root_unusable' };
  }
  return { ...refusal };
}

/** Names a root the walk never reached, so a refusal always reports something to inspect. */
function unusableRootRefusal(cacheRoot: string, productPath: string): RunnerCacheRefusal {
  return {
    reason: 'root_unusable',
    path: toManifestPath(cacheRoot, productPath) ?? undefined,
  };
}

/**
 * Walks one product with the same traversal the writer used and removes each leaf it can certify
 * from `declared`. A leaf on disk the manifest never names is unaccounted for, and a tree the walk
 * cannot describe cannot be certified at all.
 */
function validateProductAgainstManifest(
  canonicalCacheRoot: string,
  productPath: string,
  walkedRoots: readonly string[],
  declared: Map<string, RunnerCacheArtifactEntry>,
): RunnerCacheArtifactMismatch | null {
  const walk = walkRunnerCacheArtifactLeaves(canonicalCacheRoot, productPath, walkedRoots);
  if (!walk.ok) {
    return walk.refusal
      ? toWalkRefusal(walk.refusal)
      : { path: productPath, reason: 'root_unusable' };
  }
  for (const leaf of walk.leaves) {
    const entry = declared.get(leaf.relativePath);
    if (!entry) {
      return { path: leaf.relativePath, reason: 'undeclared_entry' };
    }
    const mismatch = validateManifestEntry(leaf.fullPath, leaf.relativePath, entry);
    if (mismatch) {
      return mismatch;
    }
    declared.delete(leaf.relativePath);
  }
  return null;
}

function validateManifestEntry(
  fullPath: string,
  relativePath: string,
  entry: RunnerCacheArtifactEntry,
): RunnerCacheArtifactMismatch | null {
  if ('symlink' in entry) {
    const actual = readSymlinkTarget(fullPath);
    if (actual === null) {
      return { path: relativePath, reason: 'missing' };
    }
    return actual === entry.symlink
      ? null
      : {
          path: relativePath,
          reason: 'symlink_target_changed',
          expected: entry.symlink,
          actual,
        };
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
