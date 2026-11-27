// The checked RPC route's own precondition (ADR 0006): the RPC protocol the caller names. Its
// refusal is a 409 with a typed refusal header, answered before dispatch, so the caller learns that
// nothing ran.
//
// The route reaches its protocol verdict inside the `/rpc` flow: the same envelope, the same
// decoding, and the same auth hook, tenant-trust and token gates, with the same inputs. Only a caller
// that passed all of them learns this daemon's version. A call that this build cannot decode cannot
// be authenticated the way `/rpc` would, so its protocol refusal names no version at all.
import type http from 'node:http';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { readVersion } from '@agent-device/host-kit/version';
import {
  DAEMON_CHECKED_RPC_REASONS,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_REFUSALS,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
  checkedRpcProtocolRefusal,
  type CheckedRpcProtocolRefusal,
} from '@agent-device/contracts/daemon-http';
import { createRpcError, sendJson, type JsonRpcRequest } from './http-rpc-envelope.ts';

/** The protocol refusal a checked call has earned, or `undefined` on `/rpc` or a matching protocol. */
export function readCheckedRpcProtocolRefusal(
  req: http.IncomingMessage,
  checked: boolean,
): CheckedRpcProtocolRefusal | undefined {
  return checked
    ? checkedRpcProtocolRefusal(req.headers[DAEMON_HTTP_RPC_PROTOCOL_HEADER])
    : undefined;
}

/**
 * Answers a protocol refusal. `authenticated` says whether the caller passed the `/rpc` gates: only
 * then does the refusal name this daemon's service, version and protocol, so a client can name who
 * must upgrade. Otherwise it carries the refusal and its reason alone.
 */
export function sendCheckedRpcProtocolRefusal(
  res: http.ServerResponse,
  rpcId: JsonRpcRequest['id'],
  refusal: CheckedRpcProtocolRefusal,
  authenticated: boolean,
): void {
  const missing = refusal === DAEMON_HTTP_REFUSALS.protocolMissing;
  const error = new AppError(
    'COMMAND_FAILED',
    missing
      ? `Checked RPC requires the ${DAEMON_HTTP_RPC_PROTOCOL_HEADER} header`
      : 'The daemon speaks a different RPC protocol from the caller',
    {
      reason: missing
        ? DAEMON_CHECKED_RPC_REASONS.protocolMissing.reason
        : DAEMON_CHECKED_RPC_REASONS.protocolMismatch.reason,
      dispatched: 'no',
      ...(authenticated
        ? {
            service: 'agent-device-daemon',
            version: readVersion(),
            rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
          }
        : {}),
    },
  );
  const normalized = normalizeError(error);
  res.setHeader(DAEMON_HTTP_REFUSAL_HEADER, refusal);
  sendJson(res, createRpcError(rpcId ?? null, -32001, normalized.message, normalized), 409);
}
