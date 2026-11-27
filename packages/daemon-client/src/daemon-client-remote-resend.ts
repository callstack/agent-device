// The only ways a remote command is sent a second time. Each trigger is evidence that the first send
// never dispatched: a typed pre-dispatch instance refusal on `/rpc` (ADR 0006), or, on the checked
// route, this client's own proof that the connection never opened. Nothing a response says on the
// checked route triggers a resend. Loaded only on those failures.
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  assertScriptArtifactsCapability,
  type DaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { CheckedRpcConnectFailure } from './daemon-client-checked-rpc.ts';
import { cacheRemoteDaemonHealth } from './daemon-client-remote-health-cache.ts';
import { recoverRemoteDaemonHealth } from './daemon-client-remote-health-recovery.ts';
import {
  invalidateRemoteDaemonHealth,
  isRemoteTransportFailure,
  readRemoteDaemonHealth,
  refuseAbortedRequest,
  REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS,
  requestTimeoutError,
  sendRequestWithTransport,
  type ResolvedDaemonTransport,
  type SendRequestOptions,
} from './daemon-client-transport.ts';
import {
  REMOTE_DAEMON_UNREACHABLE_HINT,
  remoteDaemonUnavailableError,
} from './daemon-lifecycle-errors.ts';

/** One failed send: what was sent, where, and the command's budget on the `performance.now()` clock. */
type FailedSend = {
  info: DaemonInfo;
  req: DaemonWireRequest;
  statePaths: DaemonPaths;
  timeoutMs: number | undefined;
  deadline: number | undefined;
  transport: ResolvedDaemonTransport;
  options: SendRequestOptions;
};

/**
 * Answers a failed checked call. Only a connection that never opened is acted on. A refused one fails
 * at once, as a refused `/health` probe does. A connect that timed out runs the `/health` recovery
 * loop within the command's budget, then sends once with the full send budget. Every other failure
 * is the caller's answer.
 */
export async function sendCheckedRpcAfterConnectFailure(
  error: unknown,
  failed: FailedSend,
): Promise<DaemonResponse> {
  const { info, req, statePaths, timeoutMs, deadline, options } = failed;
  if (!(error instanceof CheckedRpcConnectFailure)) {
    if (isRemoteTransportFailure(error)) await invalidateRemoteDaemonHealth(info);
    throw error;
  }
  if (!error.timedOut) {
    throw remoteDaemonUnavailableError({
      daemonBaseUrl: info.baseUrl,
      attempts: 1,
      hint: REMOTE_DAEMON_UNREACHABLE_HINT,
    });
  }
  await recoverRemoteDaemonHealth({
    info,
    failedProbe: { reachable: false, timedOut: true },
    recovery: timeoutMs === undefined ? undefined : { budgetMs: timeoutMs, signal: options.signal },
    deadline: deadline ?? performance.now(),
    hint: REMOTE_DAEMON_UNREACHABLE_HINT,
  });
  refuseAbortedRequest(options.signal, req.meta?.requestId);
  const { trackCheckedConnect: _once, ...resend } = options;
  return await sendRequestWithTransport(info, req, statePaths, timeoutMs, 'http', resend);
}

/**
 * Resends a `/rpc` call once after a stale-instance refusal (ADR 0006), and only to a replacement
 * whose protocol is compatible and that is answered within what is left of the command's budget.
 */
export async function retryAfterRemoteInstanceMismatch(
  failed: FailedSend,
): Promise<DaemonResponse> {
  const { info, req, statePaths, timeoutMs, deadline, transport, options } = failed;
  await invalidateRemoteDaemonHealth(info);
  const probeTimeoutMs = remainingRemoteRequestTimeoutMs(req, timeoutMs, deadline);
  const health = await readRemoteDaemonHealth(info, probeTimeoutMs, options.signal);
  refuseAbortedRequest(options.signal, req.meta?.requestId);
  const remainingMs = remainingRemoteRequestTimeoutMs(
    req,
    timeoutMs,
    deadline,
    health.timedOut ? probeTimeoutMs : undefined,
  );
  if (!health.reachable) {
    throw remoteDaemonUnavailableError({ daemonBaseUrl: info.baseUrl, attempts: 1 });
  }
  info.remoteInstanceId = health.instanceId;
  info.remoteUpstreamInstanceId = health.upstream?.instanceId;
  info.capabilities = (health.upstream ?? health).capabilities;
  cacheRemoteDaemonHealth(info, health);
  // A replacement daemon must still deliver the script that a remote recording asks for.
  if (req.meta?.scriptPublicationId) assertScriptArtifactsCapability(info.capabilities);
  try {
    return await sendRequestWithTransport(info, req, statePaths, remainingMs, transport, options);
  } catch (error) {
    if (isRemoteTransportFailure(error)) await invalidateRemoteDaemonHealth(info);
    throw error;
  }
}

function remainingRemoteRequestTimeoutMs(
  req: DaemonWireRequest,
  timeoutMs: number | undefined,
  deadline: number | undefined,
  timedOutProbeMs?: number,
): number | undefined {
  if (deadline === undefined || timeoutMs === undefined) return undefined;
  const remainingMs = deadline - performance.now();
  // A probe capped by the request can expire before the monotonic clock catches up to its timer.
  if (
    remainingMs > 0 &&
    (timedOutProbeMs === undefined || timedOutProbeMs > REMOTE_DAEMON_HEALTHCHECK_TIMEOUT_MS)
  )
    return remainingMs;
  throw requestTimeoutError(timeoutMs, req.meta?.requestId, false);
}
