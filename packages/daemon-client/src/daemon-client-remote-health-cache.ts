import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { publishFileSync } from '@agent-device/host-kit/file';
import { readVersion } from '@agent-device/host-kit/version';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { readRemoteHealthRecord, type RemoteDaemonHealth } from './daemon-client-health-record.ts';

/** A settled `/health` answer for one daemon identity. Only usable answers are cached. */
type RemoteHealthCacheEntry = {
  baseUrl: string;
  token: string;
  pid: number;
  health: RemoteDaemonHealth;
};

let remoteHealthCache: RemoteHealthCacheEntry | undefined;
/** Bumped by every invalidation, so a probe that started before one cannot cache its answer. */
let remoteHealthGeneration = 0;

/**
 * The state-directory copy of the cache, so a CLI process does not pay a `/health` round trip that
 * an earlier process already made. Safe to reuse because every RPC sent from it carries the cached
 * instance preconditions: a replaced daemon or proxy upstream answers 409 before it dispatches, and
 * the client probes again. The file names its daemon by a digest of client version, base URL and
 * token, so it never holds the token or URL, and a client upgrade or token change reads as a miss.
 */
const PERSISTED_HEALTH_FILE = 'remote-daemon-health.json';

function matchesRemoteIdentity(entry: RemoteHealthCacheEntry, info: DaemonInfo): boolean {
  return entry.baseUrl === info.baseUrl && entry.token === info.token && entry.pid === info.pid;
}

function isCacheableRemoteHealth(health: RemoteDaemonHealth): boolean {
  return (
    health.reachable && !!health.instanceId && (!health.upstream || !!health.upstream.instanceId)
  );
}

function persistedIdentity(info: DaemonInfo): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([readVersion(), info.baseUrl ?? '', info.token, info.pid]))
    .digest('hex');
}

function persistedHealthPath(stateDir: string): string {
  return path.join(stateDir, PERSISTED_HEALTH_FILE);
}

function readPersistedEntry(stateDir: string): { identity: unknown; health: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(persistedHealthPath(stateDir), 'utf8'));
    return parsed && typeof parsed === 'object'
      ? (parsed as { identity: unknown; health: unknown })
      : null;
  } catch {
    return null;
  }
}

function readPersistedHealth(info: DaemonInfo, stateDir: string): RemoteDaemonHealth | undefined {
  const persisted = readPersistedEntry(stateDir);
  if (!persisted || persisted.identity !== persistedIdentity(info)) return undefined;
  const health: RemoteDaemonHealth = {
    reachable: true,
    ...readRemoteHealthRecord(persisted.health),
  };
  return isCacheableRemoteHealth(health) ? health : undefined;
}

// The cache only saves a round trip, so a state directory it cannot write or remove from leaves the
// command to the next probe rather than failing it.
function persistHealth(info: DaemonInfo, health: RemoteDaemonHealth, stateDir: string): void {
  const entry = { identity: persistedIdentity(info), health: readRemoteHealthRecord(health) };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    publishFileSync({
      destination: persistedHealthPath(stateDir),
      contents: `${JSON.stringify(entry)}\n`,
      mode: 0o600,
    });
  } catch {}
}

function removePersistedHealth(info: DaemonInfo, stateDir: string): void {
  if (readPersistedEntry(stateDir)?.identity !== persistedIdentity(info)) return;
  try {
    fs.rmSync(persistedHealthPath(stateDir), { force: true });
  } catch {}
}

export function cacheRemoteDaemonHealth(
  info: DaemonInfo,
  health: RemoteDaemonHealth,
  stateDir?: string,
): void {
  if (!isCacheableRemoteHealth(health)) return;
  remoteHealthCache = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health,
  };
  if (stateDir) persistHealth(info, health, stateDir);
}

export function invalidateRemoteDaemonHealth(info: DaemonInfo, stateDir?: string): void {
  remoteHealthGeneration += 1;
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
  if (stateDir) removePersistedHealth(info, stateDir);
}

/** The cached answer for this daemon, from this process or from `stateDir`, without probing. */
export function readCachedRemoteHealth(
  info: DaemonInfo,
  stateDir?: string,
): RemoteDaemonHealth | undefined {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return remoteHealthCache.health;
  }
  const persisted = stateDir ? readPersistedHealth(info, stateDir) : undefined;
  if (persisted) cacheRemoteDaemonHealth(info, persisted);
  return persisted;
}

/**
 * The cached answer for this daemon, or `probe`'s, which is cached when it is usable and no
 * invalidation landed while it was in flight.
 */
export async function cachedRemoteHealth(
  info: DaemonInfo,
  probe: () => Promise<RemoteDaemonHealth>,
  stateDir?: string,
): Promise<RemoteDaemonHealth> {
  const cached = readCachedRemoteHealth(info, stateDir);
  if (cached) return cached;
  const generation = remoteHealthGeneration;
  const health = await probe();
  if (generation === remoteHealthGeneration) cacheRemoteDaemonHealth(info, health, stateDir);
  return health;
}
