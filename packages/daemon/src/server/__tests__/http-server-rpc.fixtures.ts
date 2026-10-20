import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { Server } from 'node:http';
import http from 'node:http';
import { createDaemonHttpServer } from '../http/http-server.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { listenOnLoopback } from '@agent-device/test-kit';

const RPC_ANSWER_DEADLINE_MS = 1_000;

export type RpcErrorBody = {
  id?: unknown;
  error?: { code?: number; data?: { details?: { reason?: string } } };
};

/** One `agent_device.command` call over `/rpc`, as the daemon answered it. */
export async function postRpcCommand(
  port: number,
  bearerToken: string,
  requestId: string,
): Promise<{ status: number; body: RpcErrorBody }> {
  return await postRpcRaw(
    port,
    bearerToken,
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'agent_device.command',
      params: { command: 'session_list', meta: { requestId } },
    }),
  );
}

/**
 * One `/rpc` POST of a caller-chosen body, exactly as the daemon answered it. The client-side
 * deadline is what makes a daemon that stops answering a reported failure rather than a suite
 * timeout: a flow that dies without a refusal leaves the connection waiting.
 */
export async function postRpcRaw(
  port: number,
  bearerToken: string,
  rawBody: string,
): Promise<{ status: number; body: RpcErrorBody }> {
  const { status, text } = await new Promise<{ status: number; text: string }>(
    (resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/rpc',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bearerToken}` },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.setTimeout(RPC_ANSWER_DEADLINE_MS, () => {
        req.destroy(new Error('the daemon never answered the request'));
      });
      req.on('error', reject);
      req.end(rawBody);
    },
  );
  return { status, body: JSON.parse(text) as RpcErrorBody };
}

/** A daemon listening on loopback, with `handleRequest` answering every call. */
export async function startRpcServer(
  token: string,
  handleRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
  options: Omit<
    Parameters<typeof createDaemonHttpServer>[0],
    'handleRequest' | 'token' | 'env' | 'cwd'
  > = {},
): Promise<{ port: number; server: Server }> {
  const server = await createDaemonHttpServer({
    token,
    handleRequest,
    env: process.env,
    cwd: process.cwd(),
    ...options,
  });
  return { port: (await listenOnLoopback(server)) as number, server };
}
