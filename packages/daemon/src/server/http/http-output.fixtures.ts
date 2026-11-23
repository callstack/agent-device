import { expect } from 'vitest';
import type { DaemonResponse, DaemonResponseData } from '@agent-device/kernel/contracts';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '@agent-device/contracts/daemon-http';
import { closeLoopbackServer, listenOnLoopback } from '@agent-device/test-kit';
import type { DaemonRequest } from '../../core/daemon-request.ts';
import { createDaemonHttpServer } from './http-server.ts';

type RpcBody = {
  result?: Extract<DaemonResponse, { ok: true }>;
  error?: { data?: { code?: string; details?: { reason?: string; field?: string } } };
};

export function successfulData(body: RpcBody): DaemonResponseData {
  expect(body.result?.ok, JSON.stringify(body)).toBe(true);
  expect(body.result!.data).toBeDefined();
  return body.result!.data!;
}

export function localEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  delete env.AGENT_DEVICE_HTTP_AUTH_EXPORT;
  return env;
}

export async function withHttp(
  handleRequest: (request: DaemonRequest) => Promise<DaemonResponse>,
  run: (
    post: (params: Record<string, unknown>, remote?: boolean, tenant?: string) => Promise<RpcBody>,
    base: string,
  ) => Promise<void>,
  env = localEnv(),
): Promise<void> {
  const server = await createDaemonHttpServer({
    token: 'test-token',
    handleRequest,
    env,
    cwd: process.cwd(),
  });
  try {
    const base = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    await run(async (params, remote = true, tenant) => {
      const response = await fetch(`${base}/rpc`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer test-token',
          ...(tenant ? { 'x-tenant': tenant } : {}),
          ...(remote
            ? { [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS }
            : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'output',
          method: 'agent-device.command',
          params,
        }),
      });
      return (await response.json()) as RpcBody;
    }, base);
  } finally {
    await closeLoopbackServer(server);
  }
}
