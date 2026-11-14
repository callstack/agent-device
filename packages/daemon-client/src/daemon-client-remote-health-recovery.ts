import { sleep } from '@agent-device/host-kit/retry';
import type { RemoteHealthRecovery } from './daemon-client-lifecycle.ts';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { cachedRemoteDaemonHealth, type RemoteDaemonHealth } from './daemon-client-transport.ts';
import { remoteDaemonUnavailableError } from './daemon-lifecycle-errors.ts';

/** The pause between `/health` probes while a remote daemon is unavailable. */
const REMOTE_HEALTH_REPROBE_INTERVAL_MS = 1_000;

/**
 * Whether a failed probe may have reached an endpoint that is coming back: it answered with a server
 * error, or it did not answer within the probe's time. A connection that fails outright (refused, no
 * such host) has neither, and is refused at once, so a URL with nothing listening never waits.
 */
function isTransientHealthFailure(health: RemoteDaemonHealth): boolean {
  return health.timedOut === true || health.statusCode !== undefined;
}

/**
 * Answers a remote `/health` gate whose first probe failed. When the command has a request budget
 * and the endpoint is there but not ready, it re-probes until the daemon answers or that budget
 * ends. The gate stands before the first send, so nothing reached the daemon, and a resend is safe
 * for any command, a UI action included. The wait does not shorten the send's own budget: a command
 * dispatched with too little time left could time out after it reached the device. The typed refusal
 * states every probe it made.
 */
export async function recoverRemoteDaemonHealth(params: {
  info: DaemonInfo;
  failedProbe: RemoteDaemonHealth;
  recovery: RemoteHealthRecovery | undefined;
  hint: string;
}): Promise<RemoteDaemonHealth> {
  const { info, failedProbe, recovery, hint } = params;
  let attempts = 1;
  if (recovery && isTransientHealthFailure(failedProbe)) {
    const { budgetMs, signal } = recovery;
    const deadline = performance.now() + budgetMs;
    while (!signal?.aborted) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(REMOTE_HEALTH_REPROBE_INTERVAL_MS, remainingMs), signal);
      const probeMs = deadline - performance.now();
      if (probeMs <= 0 || signal?.aborted) break;
      attempts += 1;
      const health = await cachedRemoteDaemonHealth(info, probeMs, signal);
      if (health.reachable) return health;
    }
  }
  throw remoteDaemonUnavailableError({ daemonBaseUrl: info.baseUrl, attempts, hint });
}
