// The checked RPC route's own precondition (ADR 0006): the RPC protocol the caller names. Its
// refusal is a 409 with a typed refusal header, answered before dispatch, so the caller learns that
// nothing ran.
//
// A checked call first proves the transport credential, read from the headers and the JSON frame
// alone, never through the method decoder. It then takes the `/rpc` flow: the same envelope,
// decoding, auth hook, tenant-trust and token gates, from the same inputs. The protocol refusal is
// answered only after all of them pass; any earlier failure gets the ordinary `/rpc` rejection.
import type http from 'node:http';
import { readVersion } from '@agent-device/host-kit/version';
import { resolveRequestTrackingId } from '@agent-device/host-kit/request';
import {
  buildCheckedRpcProtocolRefusal,
  checkedRpcProtocolRefusal,
  checkedRpcRefusalId,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
  type CheckedRpcProtocolRefusal,
} from '@agent-device/contracts/daemon-http';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { enforceDaemonToken, resolveToken } from './http-authorization.ts';
import { createRpcError, sendJson } from './http-rpc-envelope.ts';

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
 * Answers a checked call whose transport credential does not match, and reports whether it did. The
 * token comes from the headers or the JSON frame's `params.token`, as `/rpc` reads it, before anything
 * compares the protocol or decodes the method, so a wrong credential always gets 401.
 */
export function refuseCheckedRpcCredential(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: string,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) return false;
  const tokenError = enforceDaemonToken(
    resolveToken(readFrameParams(body), req.headers),
    expectedToken,
  );
  if (!tokenError) return false;
  sendJson(res, createRpcError(null, -32000, tokenError.message, tokenError), 401);
  return true;
}

/**
 * The request a refused checked call shows the auth gates: its own tracking id stamped as admission
 * would, but never registered, so the caller's id stays free for a call that can run.
 */
export function withUnregisteredTrackingId(
  daemonRequest: DaemonRequest,
  rpcId: unknown,
): DaemonRequest {
  const requestId = resolveRequestTrackingId(daemonRequest.meta?.requestId, rpcId);
  return { ...daemonRequest, meta: { ...daemonRequest.meta, requestId } };
}

/**
 * Answers a protocol refusal for a caller that passed every `/rpc` gate, naming this daemon's
 * service, version and protocol so the client can name who must upgrade.
 */
export function sendCheckedRpcProtocolRefusal(
  res: http.ServerResponse,
  rpcId: unknown,
  refusal: CheckedRpcProtocolRefusal,
): void {
  res.setHeader(DAEMON_HTTP_REFUSAL_HEADER, refusal);
  sendJson(
    res,
    buildCheckedRpcProtocolRefusal(checkedRpcRefusalId(rpcId), refusal, {
      service: 'agent-device-daemon',
      version: readVersion(),
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
    }),
    409,
  );
}

function readFrameParams(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    const params =
      parsed && typeof parsed === 'object' ? (parsed as { params?: unknown }).params : undefined;
    return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
