// How the daemon frames one JSON-RPC exchange on the `/rpc` socket: the envelope
// types, the error builders, and the plain/NDJSON writers that put them on the wire.
import http from 'node:http';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import type { JsonRpcId, JsonRpcRequestEnvelope } from '@agent-device/kernel/contracts';
import {
  serializeDaemonProgressEnvelope,
  serializeDaemonRpcResponseEnvelope,
} from '../../request-progress-protocol.ts';
import { statusCodeForNormalizedError } from '../http-errors.ts';

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

function statusCodeForDaemonError(error: {
  code: string;
  details?: Record<string, unknown>;
}): number {
  if (error.code === 'DEVICE_IN_USE' && error.details?.reason === 'human_control_active') {
    return 423;
  }
  return statusCodeForNormalizedError(error.code);
}

export {
  createRpcError,
  jsonRpcCodeForNormalizedError,
  sendJson,
  statusCodeForDaemonError,
  writeProgressEnvelope,
  writeRpcResponseEnvelope,
};
export type { JsonRpcRequest, JsonRpcResponse };
