import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_CACHE_METADATA_FILE } from './runner-cache-metadata.ts';

const CACHE_KEY_DIRECTORY = /^cache-[0-9a-f]{16}$/;

/**
 * Removes the build scratch from a keyed runner cache after a successful build: intermediates,
 * precompiled and module caches, logs. Reuse and launch read only the products the manifest
 * certifies and the metadata file, and a key that fails certification is deleted and rebuilt from
 * scratch, so the scratch is never read again; a runner source or Xcode change mints a new key
 * instead of building into this one.
 *
 * Returns the removed entries relative to `derived`. Nothing is removed when
 * `AGENT_DEVICE_IOS_RUNNER_CACHE_TRIM=0`, when `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH` overrides the
 * layout (a fixed path is a development loop that rebuilds into the same tree incrementally), or
 * when a product lies outside `derived`.
 */
export async function trimRunnerBuildScratch(
  derived: string,
  protectedPaths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (env.AGENT_DEVICE_IOS_RUNNER_CACHE_TRIM?.trim() === '0') return [];
  if (env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH?.trim()) return [];
  if (!CACHE_KEY_DIRECTORY.test(path.basename(derived))) return [];
  const kept = resolveKeptPaths(derived, protectedPaths);
  if (!kept) return [];
  return await trimDirectory(derived, derived, kept);
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
      const lexical = path.relative(derived, protectedPath);
      const real = path.relative(realDerived, fs.realpathSync(protectedPath));
      if (isOutside(lexical) || isOutside(real)) return null;
      kept.add(keptUnit(lexical));
      kept.add(keptUnit(real));
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

function isOutside(relative: string): boolean {
  return !relative || relative.startsWith('..') || path.isAbsolute(relative);
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
