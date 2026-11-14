import type { DaemonInfo } from './daemon-client-metadata.ts';
import type { RemoteDaemonHealth } from './daemon-client-transport.ts';

type RemoteHealthCacheEntry = {
  baseUrl: string;
  token: string;
  pid: number;
  health: Promise<RemoteDaemonHealth>;
  /** The settled answer, once the probe behind `health` has answered. */
  answer?: RemoteDaemonHealth;
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
    health: Promise.resolve(health),
    answer: health,
  };
}

export function invalidateRemoteDaemonHealth(info: DaemonInfo): void {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
}

/**
 * The remote `/health` answer through the process cache. Unbounded callers share one in-flight
 * probe. A caller with its own bound (`bounded`) reads only a settled answer and otherwise runs
 * `probe` itself, so it never waits on a probe that another caller started under a different
 * budget or signal.
 */
export async function cachedRemoteHealth(
  info: DaemonInfo,
  bounded: boolean,
  probe: () => Promise<RemoteDaemonHealth>,
): Promise<RemoteDaemonHealth> {
  const cached =
    remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)
      ? remoteHealthCache
      : undefined;
  if (cached?.answer) return cached.answer;
  if (bounded) {
    const health = await probe();
    cacheRemoteDaemonHealth(info, health);
    return health;
  }
  if (cached) return await cached.health;
  const entry: RemoteHealthCacheEntry = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health: probe(),
  };
  remoteHealthCache = entry;
  try {
    const health = await entry.health;
    if (isCacheableRemoteHealth(health)) entry.answer = health;
    else if (remoteHealthCache === entry) remoteHealthCache = undefined;
    return health;
  } catch (error) {
    if (remoteHealthCache === entry) remoteHealthCache = undefined;
    throw error;
  }
}
