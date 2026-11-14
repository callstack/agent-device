import type { DaemonInfo } from './daemon-client-metadata.ts';

export type RemoteDaemonHealth = {
  reachable: boolean;
  statusCode?: number;
  service?: string;
  version?: string;
  rpcProtocolVersion?: number;
  instanceId?: string;
  hostArch?: string;
  /** The daemon behind a proxy, as the proxy's health reported it. */
  upstream?: RemoteDaemonHealthLink;
  /** The probe ran out of its time budget before an answer, rather than failing outright. */
  timedOut?: true;
};

export type RemoteDaemonHealthLink = Pick<
  RemoteDaemonHealth,
  'service' | 'version' | 'rpcProtocolVersion' | 'instanceId' | 'hostArch'
>;

type RemoteHealthCacheEntry = {
  baseUrl: string;
  token: string;
  pid: number;
  health: Promise<RemoteDaemonHealth>;
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
  };
}

export function invalidateRemoteDaemonHealth(info: DaemonInfo): void {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    remoteHealthCache = undefined;
  }
}

/** The in-flight or cached `/health` answer for this daemon, starting `probe` when there is none. */
export function sharedRemoteHealth(
  info: DaemonInfo,
  probe: () => Promise<RemoteDaemonHealth>,
): Promise<RemoteDaemonHealth> {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return remoteHealthCache.health;
  }
  const drop = () => {
    if (remoteHealthCache === entry) remoteHealthCache = undefined;
  };
  const entry: RemoteHealthCacheEntry = {
    baseUrl: info.baseUrl ?? '',
    token: info.token,
    pid: info.pid,
    health: probe().then(
      (health) => {
        if (!isCacheableRemoteHealth(health)) drop();
        return health;
      },
      (error: unknown) => {
        drop();
        throw error;
      },
    ),
  };
  remoteHealthCache = entry;
  return entry.health;
}

/** A caller's view of a shared probe: unanswered once its own time is up, or once it aborts. */
export async function awaitWithinCallerBound(
  health: Promise<RemoteDaemonHealth>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<RemoteDaemonHealth> {
  if (timeoutMs === undefined && !signal) return await health;
  if (signal?.aborted) return { reachable: false };
  if (timeoutMs !== undefined && timeoutMs <= 0) return { reachable: false, timedOut: true };
  return await new Promise<RemoteDaemonHealth>((resolve, reject) => {
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => settle({ reachable: false, timedOut: true }), Math.ceil(timeoutMs));
    const onAbort = () => settle({ reachable: false });
    signal?.addEventListener('abort', onAbort, { once: true });
    function release(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    function settle(result: RemoteDaemonHealth): void {
      release();
      resolve(result);
    }
    health.then(settle, (error: unknown) => {
      release();
      reject(error);
    });
  });
}
