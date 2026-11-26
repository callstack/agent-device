import type { DaemonInfo } from './daemon-client-metadata.ts';
import type { RemoteHealthRecovery } from './daemon-client-lifecycle.ts';
import {
  applyRemoteDaemonHealth,
  invalidateRemoteDaemonHealth,
  readCachedRemoteHealthRecord,
  readRemoteDaemonHealth,
  type RemoteDaemonHealth,
} from './daemon-client-transport.ts';

// Loaded on the remote path only: a local daemon request never pays for the remote health cache.
const loadRemoteHealthCache = () => import('./daemon-client-remote-health-cache.ts');

/** A remote daemon's cached `/health` answer, from this process or the state directory, if any. */
export async function readCachedRemoteDaemonHealth(
  info: DaemonInfo,
  stateDir: string,
): Promise<RemoteDaemonHealth | undefined> {
  const { readCachedRemoteHealth } = await loadRemoteHealthCache();
  return readCachedRemoteHealth(info, { stateDir, readRecord: readCachedRemoteHealthRecord });
}

/** The remote `/health` answer within this caller's bound, through the cache. */
export async function cachedRemoteDaemonHealth(
  info: DaemonInfo,
  stateDir: string,
  probeTimeoutMs?: number,
  callerSignal?: AbortSignal,
): Promise<RemoteDaemonHealth> {
  const { cachedRemoteHealth } = await loadRemoteHealthCache();
  return await cachedRemoteHealth(
    info,
    () => readRemoteDaemonHealth(info, probeTimeoutMs, callerSignal),
    { stateDir, readRecord: readCachedRemoteHealthRecord },
  );
}

/**
 * Probes a remote daemon's `/health` before anything is sent to it, re-probing a daemon that is there
 * but not ready for the recovery budget, and points `info` at the daemon that answered.
 */
export async function openRemoteHealthGate(
  info: DaemonInfo,
  stateDir: string,
  healthRecovery: RemoteHealthRecovery | undefined,
): Promise<void> {
  // The command's budget starts with the first probe, which already runs under it and its signal.
  const deadline = performance.now() + (healthRecovery?.budgetMs ?? 0);
  let health = await cachedRemoteDaemonHealth(
    info,
    stateDir,
    healthRecovery?.budgetMs,
    healthRecovery?.signal,
  );
  if (!health.reachable) {
    // Loaded on the refusal: this module is not part of what every CLI start pays for.
    const { recoverRemoteDaemonHealth } = await import('./daemon-client-remote-health-recovery.ts');
    health = await recoverRemoteDaemonHealth({
      info,
      probe: (budgetMs, signal) => cachedRemoteDaemonHealth(info, stateDir, budgetMs, signal),
      failedProbe: health,
      recovery: healthRecovery,
      deadline,
      hint: 'Fix or unset --daemon-base-url or AGENT_DEVICE_DAEMON_BASE_URL so the client targets a reachable daemon or the local one. If this CLI was connected with connect proxy, run agent-device disconnect to clear the saved connection and return to the local daemon.',
    });
  }
  applyRemoteDaemonHealth(info, health);
}

/** Drops the cached answer for this daemon, then probes it as on first contact. */
export async function refreshRemoteDaemonHealth(
  info: DaemonInfo,
  stateDir: string,
  healthRecovery: RemoteHealthRecovery | undefined,
): Promise<void> {
  await invalidateRemoteDaemonHealth(info, stateDir);
  await openRemoteHealthGate(info, stateDir, healthRecovery);
}
