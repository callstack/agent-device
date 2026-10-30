import fs from 'node:fs';
import path from 'node:path';
import { isPathInsideDirectory } from './runner-artifact-manifest.ts';
import { RUNNER_CACHE_METADATA_FILE } from './runner-cache-metadata.ts';

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
 * lies outside `derived`. A key entry that is itself a symlink is never trimmed.
 */
export async function trimRunnerBuildScratch(
  derived: string,
  protectedPaths: readonly string[],
  expectedKeyPath: string,
): Promise<string[]> {
  if (!isExpectedKey(derived, expectedKeyPath)) return [];
  const kept = resolveKeptPaths(derived, protectedPaths);
  if (!kept) return [];
  return await trimDirectory(derived, derived, kept);
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
