import type { DaemonInfo } from './daemon-client-metadata.ts';
import { readRemoteDaemonHealth, type RemoteDaemonHealth } from './daemon-client-transport.ts';

type RemoteHealthCacheEntry = {
  baseUrl: string;
  token: string;
  pid: number;
  instanceId?: string;
  health: Promise<RemoteDaemonHealth>;
};

let remoteHealthCache: RemoteHealthCacheEntry | undefined;

function matchesRemoteIdentity(entry: RemoteHealthCacheEntry, info: DaemonInfo): boolean {
  return (
    entry.baseUrl === info.baseUrl &&
    entry.token === info.token &&
    entry.pid === info.pid &&
    (!info.remoteInstanceId || !entry.instanceId || entry.instanceId === info.remoteInstanceId)
  );
}

export function cacheRemoteDaemonHealth(info: DaemonInfo, health: RemoteDaemonHealth): void {
  if (!health.instanceId || (health.upstream && !health.upstream.instanceId)) return;
  remoteHealthCache = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    instanceId: health.instanceId,
    health: Promise.resolve(health),
  };
}

export function invalidateRemoteDaemonHealth(info: DaemonInfo): void {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
}

export async function cachedRemoteDaemonHealth(info: DaemonInfo): Promise<RemoteDaemonHealth> {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return await remoteHealthCache.health;
  }
  const entry: RemoteHealthCacheEntry = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health: readRemoteDaemonHealth(info),
  };
  remoteHealthCache = entry;
  try {
    const health = await entry.health;
    entry.instanceId = health.instanceId;
    if (
      (!health.reachable ||
        !health.instanceId ||
        (health.upstream && !health.upstream.instanceId)) &&
      remoteHealthCache === entry
    ) {
      remoteHealthCache = undefined;
    }
    return health;
  } catch (error) {
    if (remoteHealthCache === entry) remoteHealthCache = undefined;
    throw error;
  }
}
