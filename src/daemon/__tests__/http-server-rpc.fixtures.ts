import type { Server } from 'node:http';
import { createDaemonHttpServer } from '../server/http-server.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-request.ts';
import { listenOnLoopback } from '@agent-device/test-kit/loopback';

export type RpcErrorBody = { error?: { code?: number; data?: { details?: { reason?: string } } } };

/** One `agent_device.command` call over `/rpc`, as the daemon answered it. */
export async function postRpcCommand(
  port: number,
  bearerToken: string,
  requestId: string,
): Promise<{ status: number; body: RpcErrorBody }> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'agent_device.command',
      params: { command: 'session_list', meta: { requestId } },
    }),
  });
  return { status: response.status, body: (await response.json()) as RpcErrorBody };
}

/** A daemon listening on loopback, with `handleRequest` answering every call. */
export async function startRpcServer(
  token: string,
  handleRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
): Promise<{ port: number; server: Server }> {
  const server = await createDaemonHttpServer({ token, handleRequest });
  return { port: (await listenOnLoopback(server)) as number, server };
}
