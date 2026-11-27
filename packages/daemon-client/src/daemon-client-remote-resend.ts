// The only ways a remote command is sent a second time. Each trigger is evidence that the first send
// never dispatched: a typed pre-dispatch instance refusal on `/rpc` (ADR 0006), or, on the checked
// route, this client's own proof that the connection never opened. Nothing a response says on the
// checked route triggers a resend. Loaded only on those failures; the transport hands in what it
// owns, so this module never imports it back.
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { CheckedRpcConnectFailure } from './daemon-client-checked-rpc.ts';
import { cacheRemoteDaemonHealth } from './daemon-client-remote-health-cache.ts';
import { recoverRemoteDaemonHealth } from './daemon-client-remote-health-recovery.ts';
import type { RemoteDaemonHealth } from './daemon-client-transport.ts';
import {
  REMOTE_DAEMON_UNREACHABLE_HINT,
  remoteDaemonUnavailableError,
} from './daemon-lifecycle-errors.ts';

/** The transport's side of one failed send: how to probe, resend and refuse for that request. */
export type RemoteResendPort = {
  info: DaemonInfo;
  /** The command's budget and its end on the `performance.now()` clock, when it has one. */
  timeoutMs: number | undefined;
  deadline: number | undefined;
  signal: AbortSignal | undefined;
  /** Sends the request once more, with `timeoutMs` as its budget. */
  resend(timeoutMs: number | undefined): Promise<DaemonResponse>;
  /** A live `/health` read that refuses a skewed protocol. */
  readHealth(probeTimeoutMs: number | undefined): Promise<RemoteDaemonHealth>;
  /** A `/health` read through the process cache, as the recovery loop probes. */
  probeHealth(probeTimeoutMs: number, signal: AbortSignal | undefined): Promise<RemoteDaemonHealth>;
  invalidateHealth(): Promise<void>;
  /** Throws the typed cancellation when the caller has aborted. */
  refuseIfAborted(): void;
  /** The timeout refusal for a budget spent before anything was resent. */
  budgetSpent(): Error;
  /** Whether a failure is a transport failure that makes the cached health stale. */
  isTransportFailure(error: unknown): boolean;
  /** The `/health` probe's own time limit. */
  healthProbeTimeoutMs: number;
};

/**
 * Answers a failed checked call. Only a connection that never opened is acted on. A refused one fails
 * at once, as a refused `/health` probe does. A connect that timed out runs the `/health` recovery
 * loop on fresh probes within the command's budget, then sends once with the full send budget. Every
 * other failure is the caller's answer.
 */
export async function sendCheckedRpcAfterConnectFailure(
  error: unknown,
  port: RemoteResendPort,
): Promise<DaemonResponse> {
  if (!(error instanceof CheckedRpcConnectFailure)) {
    if (port.isTransportFailure(error)) await port.invalidateHealth();
    throw error;
  }
  // A cached `/health` answer predates this failure, so recovery decides on fresh probes only.
  await port.invalidateHealth();
  if (!error.timedOut) {
    throw remoteDaemonUnavailableError({
      daemonBaseUrl: port.info.baseUrl,
      attempts: 1,
      hint: REMOTE_DAEMON_UNREACHABLE_HINT,
    });
  }
  try {
    await recoverRemoteDaemonHealth({
      info: port.info,
      failedProbe: { reachable: false, timedOut: true },
      recovery:
        port.timeoutMs === undefined
          ? undefined
          : { budgetMs: port.timeoutMs, signal: port.signal },
      deadline: port.deadline ?? performance.now(),
      hint: REMOTE_DAEMON_UNREACHABLE_HINT,
      probe: port.probeHealth,
    });
  } catch (recoveryError) {
    // The caller's abort ends the recovery, and the caller hears its own typed cancellation.
    port.refuseIfAborted();
    throw recoveryError;
  }
  port.refuseIfAborted();
  return await port.resend(port.timeoutMs);
}

/**
 * Resends a `/rpc` call once after a stale-instance refusal (ADR 0006), and only to a replacement
 * whose protocol is compatible and that is answered within what is left of the command's budget.
 */
export async function retryAfterRemoteInstanceMismatch(
  port: RemoteResendPort,
  scriptPublicationId: string | undefined,
): Promise<DaemonResponse> {
  const { info } = port;
  await port.invalidateHealth();
  const probeTimeoutMs = remainingBudgetMs(port);
  const health = await port.readHealth(probeTimeoutMs);
  port.refuseIfAborted();
  const remainingMs = remainingBudgetMs(port, health.timedOut ? probeTimeoutMs : undefined);
  if (!health.reachable) {
    throw remoteDaemonUnavailableError({ daemonBaseUrl: info.baseUrl, attempts: 1 });
  }
  info.remoteInstanceId = health.instanceId;
  info.remoteUpstreamInstanceId = health.upstream?.instanceId;
  info.capabilities = (health.upstream ?? health).capabilities;
  cacheRemoteDaemonHealth(info, health);
  // A replacement daemon must still deliver the script that a remote recording asks for.
  if (scriptPublicationId) assertScriptArtifactsCapability(info.capabilities);
  try {
    return await port.resend(remainingMs);
  } catch (error) {
    if (port.isTransportFailure(error)) await port.invalidateHealth();
    throw error;
  }
}

function remainingBudgetMs(port: RemoteResendPort, timedOutProbeMs?: number): number | undefined {
  if (port.deadline === undefined || port.timeoutMs === undefined) return undefined;
  const remainingMs = port.deadline - performance.now();
  // A probe capped by the request can expire before the monotonic clock catches up to its timer.
  if (
    remainingMs > 0 &&
    (timedOutProbeMs === undefined || timedOutProbeMs > port.healthProbeTimeoutMs)
  )
    return remainingMs;
  throw port.budgetSpent();
}
