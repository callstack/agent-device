import fs from 'node:fs';
import path from 'node:path';
import { emitDiagnostic } from './host.ts';
import {
  acquireRunnerXctestrunCacheLock,
  emitRunnerXctestrunDecision,
  resolveRunnerCacheMetadataPath,
} from './runner-cache.ts';
import { listActiveRunnerLeaseArtifacts } from './runner-lease.ts';

const DEFAULT_RUNNER_CACHE_KEEP = 3;
// CONSERVATIVE: A key used within a day is never evicted, so a runner that has passed the cache
// decision but not yet written its lease cannot lose its products. Revisit if start no longer
// leaves that gap.
const MIN_IDLE_MS = 24 * 60 * 60_000;
const CACHE_KEY_DIRECTORY = /^cache-[0-9a-f]{16}$/;

/** How many runner cache keys per platform folder survive, the current one included; 0 keeps them all. */
export function resolveRunnerCacheKeepCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_DEVICE_IOS_RUNNER_CACHE_KEEP?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_RUNNER_CACHE_KEEP;
  return Number(raw);
}

/**
 * Removes the keyed runner caches beside `currentDerived` that no runner can use any more: not the
 * current key, not among the most recently used, idle for a day, not held by a build, and not named
 * by a live runner lease. Keys only multiply, because a runner source change or an Xcode update
 * mints a new one and the old one can never match again.
 *
 * Returns the evicted cache roots. Nothing is evicted when `AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH`
 * overrides the layout: that directory is not the keyed cache root.
 */
export async function evictStaleRunnerCaches(
  currentDerived: string,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const keep = resolveRunnerCacheKeepCount(env);
  if (keep === 0 || env.AGENT_DEVICE_IOS_RUNNER_DERIVED_PATH?.trim()) return [];
  const base = path.dirname(currentDerived);
  const candidates = listCacheKeyDirectories(base)
    .filter((entry) => entry.derived !== currentDerived)
    .sort((left, right) => right.lastUsedMs - left.lastUsedMs)
    .slice(keep - 1)
    .filter((entry) => nowMs - entry.lastUsedMs >= MIN_IDLE_MS);
  const evicted: string[] = [];
  for (const { derived } of candidates) {
    try {
      if (await evictIfUnused(derived, nowMs)) evicted.push(derived);
    } catch (error) {
      emitEvictionFailure(derived, error);
    }
  }
  return evicted;
}

function emitEvictionFailure(derived: string, error: unknown): void {
  emitDiagnostic({
    level: 'warn',
    phase: 'runner_xctestrun_cache_eviction_failed',
    data: { derived, error: error instanceof Error ? error.message : String(error) },
  });
}

type CacheKeyDirectory = { derived: string; lastUsedMs: number };

/** Last use is the mtime of the metadata file, which every reuse rewrites; a stub has none. */
function listCacheKeyDirectories(base: string): CacheKeyDirectory[] {
  let names: string[];
  try {
    names = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && CACHE_KEY_DIRECTORY.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names.map((name) => {
    const derived = path.join(base, name);
    return { derived, lastUsedMs: lastUsedMs(derived) };
  });
}

function lastUsedMs(derived: string): number {
  try {
    return fs.statSync(resolveRunnerCacheMetadataPath(derived)).mtimeMs;
  } catch {
    return 0;
  }
}

async function evictIfUnused(derived: string, nowMs: number): Promise<boolean> {
  let release: () => Promise<void>;
  try {
    release = await acquireRunnerXctestrunCacheLock(derived, 0);
  } catch {
    return false;
  }
  try {
    // Re-read under the lock: a reuse that finished after the listing refreshed the key, and its
    // runner may not have written a lease yet.
    if (nowMs - lastUsedMs(derived) < MIN_IDLE_MS) return false;
    // Leases are read under the lock: a runner needs this lock to resolve the key before it writes one.
    const key = path.basename(derived);
    const leased = listActiveRunnerLeaseArtifacts().some(
      ({ xctestrunPath, cacheKey }) =>
        cacheKey === key || xctestrunPath.startsWith(`${derived}${path.sep}`),
    );
    if (leased) return false;
    // Without its metadata a half-deleted key is never a hit; the next build for this key overwrites it.
    await fs.promises.rm(resolveRunnerCacheMetadataPath(derived), { force: true });
    await fs.promises.rm(derived, { recursive: true, force: true });
    emitRunnerXctestrunDecision('clean', 'stale_cache_evicted', { derived });
    return true;
  } finally {
    await release().catch(() => undefined);
  }
}
