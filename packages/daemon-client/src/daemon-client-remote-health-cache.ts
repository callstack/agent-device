import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openVerifiedFileForRead, publishFileSync } from '@agent-device/host-kit/file';
import { readVersion } from '@agent-device/host-kit/version';
import {
  buildDaemonHttpAuthHeaders,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import type { RemoteDaemonHealth } from './daemon-client-transport.ts';

/** Where a cached answer persists, and the `/health` contract reader a persisted record passes. */
type PersistedHealthStore = {
  stateDir: string;
  readRecord: (record: unknown) => Partial<RemoteDaemonHealth>;
};

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
 * the client probes again. Each daemon identity has its own file, named by a digest of client
 * version, RPC protocol version, base URL and token, so no file holds the token or URL, and a client
 * upgrade, protocol change or token change reads as a miss. Stale files are tiny and never read.
 */
const PERSISTED_HEALTH_FILE_PREFIX = 'remote-daemon-health-';
const PERSISTED_HEALTH_MAX_BYTES = 16 * 1024;

function matchesRemoteIdentity(entry: RemoteHealthCacheEntry, info: DaemonInfo): boolean {
  return entry.baseUrl === info.baseUrl && entry.token === info.token && entry.pid === info.pid;
}

const INSTANCE_ID_MAX_LENGTH = 256;
// The characters Node accepts in a header value: an ID outside them could never be sent.
const HEADER_VALUE = /^[\t\u0020-\u007e\u0080-\u00ff]+$/;

/**
 * An instance ID a later request can carry as its precondition header: a bounded, valid header
 * value that does not echo the credential or the URL this client sent to `/health`.
 */
function isUsableInstanceId(value: string | undefined, info: DaemonInfo): value is string {
  // The credential as `/health` received it: the auth header builder trims it.
  const sentToken = buildDaemonHttpAuthHeaders(info.token)['x-agent-device-token'];
  return (
    typeof value === 'string' &&
    value.length <= INSTANCE_ID_MAX_LENGTH &&
    HEADER_VALUE.test(value) &&
    !(sentToken && value.includes(sentToken)) &&
    !(info.baseUrl && value.includes(info.baseUrl))
  );
}

// A proxy fences its upstream only through the upstream ID, so a proxy answer needs one.
function isCacheableRemoteHealth(health: RemoteDaemonHealth, info: DaemonInfo): boolean {
  const needsUpstream = health.upstream !== undefined || health.service === 'agent-device-proxy';
  return (
    health.reachable &&
    isUsableInstanceId(health.instanceId, info) &&
    (!needsUpstream || isUsableInstanceId(health.upstream?.instanceId, info))
  );
}

function persistedIdentity(info: DaemonInfo): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        readVersion(),
        DAEMON_RPC_PROTOCOL_VERSION,
        info.baseUrl ?? '',
        info.token,
        info.pid,
      ]),
    )
    .digest('hex');
}

function persistedHealthPath(stateDir: string, identity: string): string {
  return path.join(stateDir, `${PERSISTED_HEALTH_FILE_PREFIX}${identity.slice(0, 16)}.json`);
}

/**
 * The state directory may be shared, so the entry counts only when it is a bounded regular file this
 * user owns and nobody else can write. A link, FIFO or other special file reads as a miss without
 * blocking, and the caller probes `/health` instead.
 */
function readPersistedEntry(
  stateDir: string,
  identity: string,
): { identity: unknown; health: unknown } | null {
  try {
    const descriptor = openVerifiedFileForRead(persistedHealthPath(stateDir, identity));
    if (descriptor === undefined) return null;
    try {
      const stats = fs.fstatSync(descriptor);
      if (!isPrivateOwnedFile(stats)) return null;
      const buffer = Buffer.alloc(stats.size);
      const length = fs.readSync(descriptor, buffer, 0, stats.size, 0);
      const parsed: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
      return parsed && typeof parsed === 'object'
        ? (parsed as { identity: unknown; health: unknown })
        : null;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
}

// Windows has no POSIX owner or mode bits; its ACLs are out of scope (docs/agents/security.md).
function isPrivateOwnedFile(stats: fs.Stats): boolean {
  if (!stats.isFile() || stats.size > PERSISTED_HEALTH_MAX_BYTES) return false;
  const uid = process.getuid?.();
  return uid === undefined || (stats.uid === uid && (stats.mode & 0o022) === 0);
}

function readPersistedHealth(
  info: DaemonInfo,
  store: PersistedHealthStore,
): RemoteDaemonHealth | undefined {
  const identity = persistedIdentity(info);
  const persisted = readPersistedEntry(store.stateDir, identity);
  // The file name holds a digest prefix; the full digest inside rules out a prefix collision.
  if (!persisted || persisted.identity !== identity) return undefined;
  const health: RemoteDaemonHealth = { reachable: true, ...store.readRecord(persisted.health) };
  return isCacheableRemoteHealth(health, info) ? health : undefined;
}

// The cache only saves a round trip, so a state directory it cannot write or remove from leaves the
// command to the next probe rather than failing it.
function persistHealth(info: DaemonInfo, health: RemoteDaemonHealth, stateDir: string): void {
  // Only what admits a later request: the instance preconditions and the capabilities.
  const { instanceId, capabilities, upstream } = health;
  const record = {
    instanceId,
    capabilities,
    ...(upstream
      ? { upstream: { instanceId: upstream.instanceId, capabilities: upstream.capabilities } }
      : {}),
  };
  const identity = persistedIdentity(info);
  const entry = { identity, health: record };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    publishFileSync({
      destination: persistedHealthPath(stateDir, identity),
      contents: `${JSON.stringify(entry)}\n`,
      mode: 0o600,
    });
  } catch {}
}

function removePersistedHealth(info: DaemonInfo, stateDir: string): void {
  const identity = persistedIdentity(info);
  if (readPersistedEntry(stateDir, identity)?.identity !== identity) return;
  try {
    fs.rmSync(persistedHealthPath(stateDir, identity), { force: true });
  } catch {}
}

export function cacheRemoteDaemonHealth(
  info: DaemonInfo,
  health: RemoteDaemonHealth,
  stateDir?: string,
): void {
  if (!isCacheableRemoteHealth(health, info)) return;
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
  store?: PersistedHealthStore,
): RemoteDaemonHealth | undefined {
  if (remoteHealthCache && matchesRemoteIdentity(remoteHealthCache, info)) {
    return remoteHealthCache.health;
  }
  const persisted = store ? readPersistedHealth(info, store) : undefined;
  if (persisted) cacheRemoteDaemonHealth(info, persisted);
  return persisted;
}

/**
 * A live answer from `probe`, cached when it is usable and no invalidation landed while it was in
 * flight. It never reads a cached answer, so a forced refresh always asks the daemon.
 */
export async function probedRemoteHealth(
  info: DaemonInfo,
  probe: () => Promise<RemoteDaemonHealth>,
  stateDir?: string,
): Promise<RemoteDaemonHealth> {
  const generation = remoteHealthGeneration;
  const health = await probe();
  if (generation === remoteHealthGeneration) cacheRemoteDaemonHealth(info, health, stateDir);
  return health;
}
