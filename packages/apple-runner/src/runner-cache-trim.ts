import fs from 'node:fs';
import path from 'node:path';
import { isPathInsideDirectory } from './runner-artifact-manifest.ts';
import { RUNNER_CACHE_READER_GRACE_MS } from './runner-cache.ts';
import { RUNNER_CACHE_METADATA_FILE } from './runner-cache-metadata.ts';
import { listActiveRunnerLeaseArtifacts } from './runner-lease.ts';

// A build's products directory sits at `Build/<products>`, so a tree is never deeper than this.
const RUNNER_TREE_MAX_DEPTH = 2;

/**
 * Removes the build scratch from a keyed runner cache after a successful build: intermediates,
 * precompiled and module caches, logs. Reuse and launch read only the products the manifest
 * certifies and the metadata file, and a key that fails certification is deleted and rebuilt from
 * scratch, so the scratch is never read again; a runner source or Xcode change mints a new key
 * instead of building into this one.
 *
 * Returns the removed entries relative to `derived`. Nothing is removed unless `derived` resolves,
 * by real path, to a real directory named like `expectedKeyPath` that is a direct child of the real
 * parent of `expectedKeyPath` (the key this build gets with no path override), or when a product
 * lies outside `derived`. A key entry that is itself a symlink is never trimmed. Trees another
 * session may still read survive (see {@link listLiveRunnerTrees}).
 */
export async function trimRunnerBuildScratch(
  derived: string,
  protectedPaths: readonly string[],
  expectedKeyPath: string,
): Promise<string[]> {
  if (!isExpectedKey(derived, expectedKeyPath)) return [];
  const kept = resolveKeptPaths(derived, protectedPaths);
  if (!kept) return [];
  const live = listLiveRunnerTrees(derived);
  if (live.includes('')) return [];
  for (const tree of live) kept.add(keptUnit(tree));
  return await trimDirectory(derived, derived, kept);
}

/**
 * Removes everything under `derived` except the `kept` entries (relative to `derived`) and the
 * directories that hold them. A kept tree at the root keeps everything but the cache metadata.
 */
export async function removeRunnerCacheEntriesExcept(
  derived: string,
  kept: ReadonlySet<string>,
): Promise<void> {
  if (kept.has('')) {
    await fs.promises.rm(path.join(derived, RUNNER_CACHE_METADATA_FILE), { force: true });
    return;
  }
  await trimDirectory(derived, derived, kept);
}

/**
 * The runner trees under `derived` (directories holding an `.xctestrun`, relative to `derived`)
 * that a session may still read: one resolved within {@link RUNNER_CACHE_READER_GRACE_MS}, or one
 * a live runner lease names. When the leases cannot be listed, every tree counts.
 */
export function listLiveRunnerTrees(derived: string, nowMs: number = Date.now()): string[] {
  const trees = listRunnerTrees(derived, '');
  let leasedTrees: Set<string>;
  try {
    leasedTrees = new Set(
      listActiveRunnerLeaseArtifacts().map(({ xctestrunPath }) =>
        path.resolve(path.dirname(xctestrunPath)),
      ),
    );
  } catch {
    return trees;
  }
  return trees.filter((tree) => {
    const directory = path.resolve(derived, tree);
    const resolvedAtMs = fs.statSync(directory, { throwIfNoEntry: false })?.mtimeMs ?? 0;
    return nowMs - resolvedAtMs < RUNNER_CACHE_READER_GRACE_MS || leasedTrees.has(directory);
  });
}

function listRunnerTrees(derived: string, relative: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(derived, relative), { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((entry) => entry.isFile() && entry.name.endsWith('.xctestrun')))
    return [relative];
  if (relative.split(path.sep).filter(Boolean).length >= RUNNER_TREE_MAX_DEPTH) return [];
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => listRunnerTrees(derived, path.join(relative, entry.name)));
}

function isExpectedKey(derived: string, expectedKeyPath: string): boolean {
  try {
    const canonicalKey = path.join(
      fs.realpathSync(path.dirname(expectedKeyPath)),
      path.basename(expectedKeyPath),
    );
    return fs.realpathSync(derived) === canonicalKey;
  } catch {
    return false;
  }
}

/**
 * `Build/<x>` is the unit kept under `Build`, so the products survive and their siblings do not.
 * A product that is missing or lies outside the key makes the trim a no-op. A product that is a
 * symlink keeps its target's unit as well.
 */
function resolveKeptPaths(derived: string, protectedPaths: readonly string[]): Set<string> | null {
  const kept = new Set<string>([RUNNER_CACHE_METADATA_FILE]);
  try {
    const realDerived = fs.realpathSync(derived);
    for (const protectedPath of protectedPaths) {
      const realProtected = fs.realpathSync(protectedPath);
      if (
        !isPathInsideDirectory(protectedPath, derived) ||
        !isPathInsideDirectory(realProtected, realDerived)
      ) {
        return null;
      }
      kept.add(keptUnit(path.relative(derived, protectedPath)));
      kept.add(keptUnit(path.relative(realDerived, realProtected)));
    }
  } catch {
    return null;
  }
  return kept;
}

function keptUnit(relative: string): string {
  const segments = relative.split(path.sep);
  return segments.slice(0, segments[0] === 'Build' ? 2 : 1).join(path.sep);
}

async function trimDirectory(
  root: string,
  directory: string,
  kept: ReadonlySet<string>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const relative = path.relative(root, entryPath);
    if (kept.has(relative)) continue;
    if (
      entry.isDirectory() &&
      [...kept].some((keep) => keep.startsWith(`${relative}${path.sep}`))
    ) {
      removed.push(...(await trimDirectory(root, entryPath, kept)));
      continue;
    }
    await fs.promises.rm(entryPath, { recursive: true, force: true });
    removed.push(relative);
  }
  return removed;
}
