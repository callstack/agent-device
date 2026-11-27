// The proxy's checked RPC admission (ADR 0006): its own protocol refusal, and the refusal header it
// carries back from the daemon behind it. Loaded only on the checked route.
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  checkedRpcProtocolRefusal,
  DAEMON_CHECKED_RPC_REASONS,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_REFUSALS,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
  type CheckedRpcProtocolRefusal,
} from '@agent-device/contracts/daemon-http';

/**
 * Refuses an authenticated checked call whose RPC protocol header is absent or names another
 * protocol. It runs after authentication and before the envelope check, the tenant method rules,
 * and any forwarding.
 */
export async function refuseCheckedRpcProtocol(
  request: Request,
  rpcId: unknown,
): Promise<Response | null> {
  const refusal = checkedRpcProtocolRefusal(request.headers.get(DAEMON_HTTP_RPC_PROTOCOL_HEADER));
  if (!refusal) return null;
  const { readVersion } = await import('@agent-device/host-kit/version');
  const error = normalizeError(checkedRpcProtocolRefusalError(refusal, readVersion()));
  return Response.json(
    { jsonrpc: '2.0', id: rpcId, error: { code: -32001, message: error.message, data: error } },
    { status: 409, headers: { [DAEMON_HTTP_REFUSAL_HEADER]: refusal } },
  );
}

/** The refusal names this proxy in the `/health` vocabulary, so a client names who must upgrade. */
function checkedRpcProtocolRefusalError(
  refusal: CheckedRpcProtocolRefusal,
  version: string,
): AppError {
  const missing = refusal === DAEMON_HTTP_REFUSALS.protocolMissing;
  return new AppError(
    'COMMAND_FAILED',
    missing
      ? `Checked RPC requires the ${DAEMON_HTTP_RPC_PROTOCOL_HEADER} header`
      : 'The proxy speaks a different RPC protocol from the caller',
    {
      reason: missing
        ? DAEMON_CHECKED_RPC_REASONS.protocolMissing.reason
        : DAEMON_CHECKED_RPC_REASONS.protocolMismatch.reason,
      dispatched: 'no',
      service: 'agent-device-proxy',
      version,
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    },
  );
}

/**
 * The refusal header a checked call's 409 carries back through the proxy. A protocol refusal of the
 * daemon behind the proxy says so, so the client names that daemon and not the proxy. Only the
 * known values pass, and only on a 409 of the checked route.
 */
export function forwardedCheckedRpcRefusal(upstreamResponse: Response): string | undefined {
  if (upstreamResponse.status !== 409) return undefined;
  switch (upstreamResponse.headers.get(DAEMON_HTTP_REFUSAL_HEADER)) {
    case DAEMON_HTTP_REFUSALS.protocolMismatch:
    case DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch:
      return DAEMON_HTTP_REFUSALS.upstreamProtocolMismatch;
    case DAEMON_HTTP_REFUSALS.protocolMissing:
      return DAEMON_HTTP_REFUSALS.protocolMissing;
    default:
      return undefined;
  }
}
