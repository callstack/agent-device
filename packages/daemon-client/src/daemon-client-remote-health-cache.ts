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

function matchesRemoteIdentity(entry: RemoteHealthCacheEntry, info: DaemonInfo): boolean {
  return entry.baseUrl === info.baseUrl && entry.token === info.token && entry.pid === info.pid;
}

function isCacheableRemoteHealth(health: RemoteDaemonHealth): boolean {
  return (
    health.reachable && !!health.instanceId && (!health.upstream || !!health.upstream.instanceId)
  );
}

export function cacheRemoteDaemonHealth(info: DaemonInfo, health: RemoteDaemonHealth): void {
  if (!isCacheableRemoteHealth(health)) return;
  remoteHealthCache = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health,
  };
}

export function invalidateRemoteDaemonHealth(info: DaemonInfo): void {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
}

/** The cached answer for this daemon, or `probe`'s, which is cached when it is usable. */
export async function cachedRemoteHealth(
  info: DaemonInfo,
  probe: () => Promise<RemoteDaemonHealth>,
): Promise<RemoteDaemonHealth> {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return remoteHealthCache.health;
  }
  const health = await probe();
  cacheRemoteDaemonHealth(info, health);
  return health;
}
