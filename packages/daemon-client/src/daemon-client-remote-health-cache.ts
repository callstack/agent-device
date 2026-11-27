import type { DaemonInfo } from './daemon-client-metadata.ts';
import type { RemoteDaemonHealth } from './daemon-client-transport.ts';

/** A settled `/health` answer for one daemon identity. Only usable answers are cached. */
type RemoteHealthCacheEntry = {
  baseUrl: string;
  token: string;
  pid: number;
  health: RemoteDaemonHealth;
};

let remoteHealthCache: RemoteHealthCacheEntry | undefined;
/** The identity whose last reachable answer named no complete instance ID, so it could not be cached. */
let unpinnedRemoteIdentity: Omit<RemoteHealthCacheEntry, 'health'> | undefined;
/** Bumped by every invalidation, so a probe that started before one cannot cache its answer. */
let remoteHealthGeneration = 0;

function matchesRemoteIdentity(
  entry: Omit<RemoteHealthCacheEntry, 'health'>,
  info: DaemonInfo,
): boolean {
  return entry.baseUrl === info.baseUrl && entry.token === info.token && entry.pid === info.pid;
}

function isCacheableRemoteHealth(health: RemoteDaemonHealth): boolean {
  return (
    health.reachable && !!health.instanceId && (!health.upstream || !!health.upstream.instanceId)
  );
}

/**
 * Records a `/health` answer: a pinned one is cached for reuse, and a reachable one that names no
 * complete instance ID is remembered as unpinnable, so a later checked-eligible call stays
 * health-first. Every reader goes through here: the ordinary probe and the stale-instance retry.
 */
export function cacheRemoteDaemonHealth(info: DaemonInfo, health: RemoteDaemonHealth): void {
  if (!isCacheableRemoteHealth(health)) {
    if (health.reachable) {
      unpinnedRemoteIdentity = { baseUrl: info.baseUrl ?? '', token: info.token, pid: info.pid };
    }
    return;
  }
  remoteHealthCache = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health,
  };
}

/**
 * Whether this process already read `/health` for this daemon identity: it holds an instance-pinned
 * answer, or its last reachable answer could not be pinned. Either way, what follows goes
 * health-first: the pinned answer is reused, fenced and free; an unpinnable one is read again.
 */
export function hasReadRemoteHealth(info: DaemonInfo): boolean {
  return [remoteHealthCache, unpinnedRemoteIdentity].some(
    (entry) => entry !== undefined && matchesRemoteIdentity(entry, info),
  );
}

export function invalidateRemoteDaemonHealth(info: DaemonInfo): void {
  remoteHealthGeneration += 1;
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
  if (unpinnedRemoteIdentity && matchesRemoteIdentity(unpinnedRemoteIdentity, info)) {
    unpinnedRemoteIdentity = undefined;
  }
}

/**
 * The cached answer for this daemon, or `probe`'s, which is cached when it is usable and no
 * invalidation landed while it was in flight.
 */
export async function cachedRemoteHealth(
  info: DaemonInfo,
  probe: () => Promise<RemoteDaemonHealth>,
): Promise<RemoteDaemonHealth> {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return remoteHealthCache.health;
  }
  const generation = remoteHealthGeneration;
  const health = await probe();
  if (generation === remoteHealthGeneration) cacheRemoteDaemonHealth(info, health);
  return health;
}
