// The only ways a remote command is sent a second time. Each trigger is evidence that the first send
// never dispatched: a typed pre-dispatch instance refusal on `/rpc` (ADR 0006), or, on the checked
// route, this client's own proof that the connection never opened. Nothing a response says on the
// checked route triggers a resend. Loaded only on those failures; the transport hands in what it
// owns as a `RemoteResendPort`, declared below both in `daemon-client-remote-resend-port.ts`.
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  assertLeaseAdmissionCapability,
  assertScriptArtifactsCapability,
} from '@agent-device/daemon-contracts/daemon-resolution';
import {
  CheckedRpcConnectFailure,
  undispatchedWithoutEndpoint,
} from './daemon-client-checked-rpc.ts';
import { cacheRemoteDaemonHealth } from './daemon-client-remote-health-cache.ts';
import { recoverRemoteDaemonHealth } from './daemon-client-remote-health-recovery.ts';
import type { RemoteResendPort } from './daemon-client-remote-resend-port.ts';
import {
  REMOTE_DAEMON_UNREACHABLE_HINT,
  remoteDaemonUnavailableError,
} from './daemon-lifecycle-errors.ts';

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
  try {
    // The observed connect verdict is the first failed probe: a refused connection is not transient
    // and fails at once, and only a connect that timed out enters the probe loop.
    await recoverRemoteDaemonHealth({
      info: port.info,
      failedProbe: error.timedOut ? { reachable: false, timedOut: true } : { reachable: false },
      recovery:
        port.timeoutMs === undefined
          ? undefined
          : { budgetMs: port.timeoutMs, signal: port.signal },
      deadline: port.deadline ?? performance.now(),
      hint: REMOTE_DAEMON_UNREACHABLE_HINT,
      probe: port.probeHealth,
    });
  } catch (recoveryError) {
    // The caller's abort ends the recovery, and the caller hears its own typed cancellation. Every
    // other recovery failure, protocol skew included, comes before the resend: nothing left, and
    // the error names no endpoint.
    port.refuseIfAborted();
    throw undispatchedWithoutEndpoint(recoveryError);
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
  leaseCheckedByAdmission: boolean | undefined,
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
  // A replacement that cannot check the lease at admission gets the heartbeat path instead.
  if (leaseCheckedByAdmission) assertLeaseAdmissionCapability(info.capabilities);
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
