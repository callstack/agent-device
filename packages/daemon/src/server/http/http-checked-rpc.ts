// The checked RPC route's own preconditions (ADR 0006): the RPC protocol the caller names, and the
// capability its request needs. Every refusal here is a 409 with a typed refusal header, answered
// before dispatch, so the caller learns that nothing ran.
import type http from 'node:http';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
import { readVersion } from '@agent-device/host-kit/version';
import {
  checkedRpcProtocolRefusalError,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_REFUSALS,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  checkedRpcProtocolRefusal,
  type DaemonHttpRefusal,
} from '@agent-device/contracts/daemon-http';
import { assertScriptArtifactsCapability } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import {
  enforceDaemonToken,
  resolveToken,
  runHttpAuthHook,
  type HttpAuthHook,
} from './http-authorization.ts';
import { createRpcError, sendJson, type JsonRpcRequest } from './http-rpc-envelope.ts';

/**
 * Answers a checked call whose RPC protocol header is absent or names another protocol, and reports
 * whether it did. It reads only the stable JSON-RPC framing, never this build's params decoding, so
 * a caller on any protocol gets the refusal. It authenticates first, with the token and the auth hook,
 * so an unauthenticated caller learns nothing about this daemon.
 */
export async function refuseCheckedRpcProtocol(params: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  body: string;
  authHook: HttpAuthHook | null;
  expectedToken: string | undefined;
}): Promise<boolean> {
  const { req, res, body, authHook, expectedToken } = params;
  const refusal = checkedRpcProtocolRefusal(req.headers[DAEMON_HTTP_RPC_PROTOCOL_HEADER]);
  if (!refusal) return false;
  const frame = readStableRpcFrame(body);
  const token = resolveToken(frame.params, req.headers);
  const tokenError = enforceDaemonToken(token, expectedToken);
  if (tokenError) {
    sendJson(
      res,
      createRpcError(frame.rpcRequest.id ?? null, -32000, tokenError.message, tokenError),
      401,
    );
    return true;
  }
  const authResult = await runHttpAuthHook(authHook, {
    headers: req.headers,
    rpcRequest: frame.rpcRequest,
    daemonRequest: {
      token,
      session: 'default',
      command: typeof frame.params.command === 'string' ? frame.params.command : '',
      positionals: [],
    },
  });
  if (!authResult.ok) {
    sendJson(res, authResult.response, authResult.statusCode);
    return true;
  }
  sendCheckedRpcRefusal(
    res,
    frame.rpcRequest.id ?? null,
    refusal,
    checkedRpcProtocolRefusalError(refusal, {
      service: 'agent-device-daemon',
      version: readVersion(),
    }),
  );
  return true;
}

/**
 * Answers an admitted checked call that this daemon cannot serve, and reports whether it did. A call
 * that records a session script (`meta.scriptPublicationId`) needs the `script-artifacts` capability,
 * so the requirement comes from the request itself and no header can remove it.
 */
export function refuseUnservedCheckedRequest(
  res: http.ServerResponse,
  rpcId: JsonRpcRequest['id'],
  daemonRequest: DaemonRequest,
  capabilities: readonly string[],
): boolean {
  if (!daemonRequest.meta?.scriptPublicationId) return false;
  try {
    assertScriptArtifactsCapability(capabilities);
    return false;
  } catch (error) {
    sendCheckedRpcRefusal(res, rpcId ?? null, DAEMON_HTTP_REFUSALS.scriptArtifacts, error);
    return true;
  }
}

function sendCheckedRpcRefusal(
  res: http.ServerResponse,
  rpcId: JsonRpcRequest['id'],
  refusal: DaemonHttpRefusal,
  error: unknown,
): void {
  const normalized = normalizeError(
    error instanceof AppError ? error : new AppError('COMMAND_FAILED', String(error)),
  );
  res.setHeader(DAEMON_HTTP_REFUSAL_HEADER, refusal);
  sendJson(res, createRpcError(rpcId ?? null, -32001, normalized.message, normalized), 409);
}

/** The JSON-RPC framing every protocol shares: the call id, its method, and its params object. */
function readStableRpcFrame(body: string): {
  rpcRequest: JsonRpcRequest;
  params: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const frame = isRecord(parsed) ? parsed : {};
  const id = typeof frame.id === 'string' || typeof frame.id === 'number' ? frame.id : null;
  const method = typeof frame.method === 'string' ? frame.method : '';
  const params = isRecord(frame.params) ? frame.params : {};
  return { rpcRequest: { jsonrpc: '2.0', id, method, params }, params };
}
