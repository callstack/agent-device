import assert from 'node:assert/strict';

import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { expect, test, vi } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '@agent-device/contracts/daemon-http';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createDaemonHttpServer } from './http-server.ts';
import type { DaemonRequest } from '../../core/daemon-request.ts';

type RpcResponse = { error?: { data?: { code?: string } } };

test('public HTTP marks command and lease requests before dispatch', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const requests: DaemonRequest[] = [];
  const token = 'limrun-http-test-token';
  const leaseRegistry = new LeaseRegistry();
  const handleRequest = vi.fn(async (request: DaemonRequest): Promise<DaemonResponse> => {
    requests.push(request);
    return { ok: true, data: {} };
  });
  const server = await createDaemonHttpServer({ token, leaseRegistry, handleRequest });

  try {
    const port = await listenOnLoopback(server);
    const apps = await callRpc(port, token, {
      jsonrpc: '2.0',
      id: 'limrun-public-apps',
      method: 'agent_device.command',
      params: {
        command: 'apps',
        positionals: [],
        flags: { platform: 'android', leaseProvider: 'limrun' },
      },
    });
    const allocation = await callRpc(port, token, {
      jsonrpc: '2.0',
      id: 'limrun-public-allocation',
      method: 'agent_device.lease.allocate',
      params: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        backend: 'android-instance',
        leaseProvider: 'limrun',
        providerApp: 'Example.apk',
      },
    });

    assert.equal(apps.error, undefined);
    assert.equal(allocation.error, undefined);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.command)).toEqual(['apps', 'lease_allocate']);
    expect(requests.every((request) => request.internal?.publicNetworkOnly === true)).toBe(true);
    expect(requests[1]?.meta?.leaseProvider).toBe('limrun');
  } finally {
    await closeLoopbackServer(server);
  }
});

async function callRpc(
  port: number,
  token: string,
  payload: Record<string, unknown>,
): Promise<RpcResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      [DAEMON_HTTP_NETWORK_ACCESS_HEADER]: DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
    },
    body: JSON.stringify(payload),
  });
  return (await response.json()) as RpcResponse;
}
