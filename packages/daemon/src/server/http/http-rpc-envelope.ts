// How the daemon frames one JSON-RPC exchange on the `/rpc` socket: the envelope
// types, the error builders, and the plain/NDJSON writers that put them on the wire.
import http from 'node:http';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import type { JsonRpcId, JsonRpcRequestEnvelope } from '@agent-device/kernel/contracts';
import {
  serializeDaemonProgressEnvelope,
  serializeDaemonRpcResponseEnvelope,
} from '@agent-device/daemon-contracts/request-progress-protocol';

type JsonRpcRequest = JsonRpcRequestEnvelope;

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: Record<string, unknown>;
  };
};

function createRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
}

function sendJson(
  res: http.ServerResponse<http.IncomingMessage>,
  response: JsonRpcResponse,
  httpCode: number = 200,
): void {
  res.statusCode = httpCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(response));
}

function writeProgressEnvelope(
  res: http.ServerResponse<http.IncomingMessage>,
  event: RequestProgressEvent,
): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(serializeDaemonProgressEnvelope(event));
}

function writeRpcResponseEnvelope(
  res: http.ServerResponse<http.IncomingMessage>,
  response: JsonRpcResponse,
): void {
  if (res.destroyed) return;
  res.write(serializeDaemonRpcResponseEnvelope(response));
  res.end();
}

// Map a thrown boundary error to its JSON-RPC error code. Invalid params (malformed
// wire input rejected before the request reaches the handler) is JSON-RPC -32602, to
// match the explicit `Invalid params` sibling checks below; everything else is the
// generic application error -32000.
function jsonRpcCodeForNormalizedError(code: string): number {
  return code === 'INVALID_ARGS' ? -32602 : -32000;
}

export {
  createRpcError,
  jsonRpcCodeForNormalizedError,
  sendJson,
  writeProgressEnvelope,
  writeRpcResponseEnvelope,
};
export type { JsonRpcRequest, JsonRpcResponse };
