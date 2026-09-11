import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import type { DaemonRequest, DaemonResponse } from '../../../src/daemon/daemon-request.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

// The compact lease envelope is the only projection that has to name provider session metadata by
// key; the daemon's lease request must carry every one of those keys, and only those.
test('Provider-backed integration daemon HTTP lease allocate forwards provider session metadata as request flags', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP lease allocate coverage')) return;

  const observedRequests: DaemonRequest[] = [];
  const server = await createDaemonHttpServer({
    token: 'provider-scenario-token',
    handleRequest: async (req): Promise<DaemonResponse> => {
      observedRequests.push(req);
      return { ok: true, data: { command: req.command } };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer provider-scenario-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'rpc-lease-provider',
        method: 'agent_device.lease.allocate',
        params: {
          tenantId: 'Tenant A',
          runId: 'run-1',
          backend: 'ios-instance',
          leaseProvider: 'browserstack',
          providerApp: 'bs://app-id',
          providerProject: 'MyProject',
          providerBuild: 'Build-1',
          providerSessionName: 'smoke',
        },
      }),
    });
    assert.equal(response.status, 200);

    const leaseRequest = observedRequests.find((req) => req.command === 'lease_allocate');
    assert.deepEqual(leaseRequest?.flags, {
      providerApp: 'bs://app-id',
      providerProject: 'MyProject',
      providerBuild: 'Build-1',
      providerSessionName: 'smoke',
    });
  } finally {
    await closeLoopbackServer(server);
  }
});
