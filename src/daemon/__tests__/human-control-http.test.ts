import assert from 'node:assert/strict';
import http from 'node:http';
import { test, vi } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { HUMAN_CONTROL_HTTP_PREFIX } from '../human-control-contract.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import {
  HUMAN_CONTROL_SCOPE,
  humanControlRequest,
  createControlLatch,
} from './human-control-fixtures.ts';
import { createHumanControlHarness } from './human-control-router-fixture.ts';
import { tryHandleHumanControlHttpRoute } from '../human-control-http.ts';
import { createDaemonHttpServer } from '../server/http-server.ts';

test('malformed request URLs return a normalized error', async () => {
  let responseBody = '';
  let finishResponse: (() => void) | undefined;
  const responseFinished = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  const req = {
    url: 'http://[',
    method: 'PUT',
    headers: { authorization: 'Bearer daemon-secret' },
  } as http.IncomingMessage;
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (body: string) => {
      responseBody = body;
      finishResponse?.();
    },
  } as unknown as http.ServerResponse;

  assert.equal(
    tryHandleHumanControlHttpRoute({
      req,
      res,
      expectedToken: 'daemon-secret',
      registry: new LeaseRegistry(),
    }),
    true,
  );
  await responseFinished;
  assert.equal(res.statusCode, 400);
  assert.equal((JSON.parse(responseBody) as { code?: string }).code, 'INVALID_ARGS');
});

for (const transport of ['tenant RPC', 'host PUT'] as const) {
  test(`${transport} disconnect during drain removes its pending hold before the mutation ends`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { registry, lease, handleRequest } = createHumanControlHarness();
    const finish = createControlLatch();
    const disconnected = createControlLatch();
    let mutationFinished = false;
    const mutation = registry.runDeviceMutation(lease, async () => {
      await finish.promise;
      mutationFinished = true;
    });
    const server = await createDaemonHttpServer({
      token: 'test-token',
      leaseRegistry: registry,
      handleRequest,
    });
    server.on('request', (_req, res) => {
      res.once('close', () => {
        if (!res.writableFinished) disconnected.resolve();
      });
    });
    let request: http.ClientRequest | undefined;
    try {
      const port = await listenOnLoopback(server);
      const isRpc = transport === 'tenant RPC';
      const body = JSON.stringify(
        isRpc
          ? {
              jsonrpc: '2.0',
              id: 'disconnected-takeover',
              method: 'agent_device.command',
              params: humanControlRequest(lease, 'human_control', ['put', 'disconnected', '{}']),
            }
          : { scope: HUMAN_CONTROL_SCOPE },
      );
      request = http.request({
        host: '127.0.0.1',
        port,
        path: isRpc ? '/rpc' : `${HUMAN_CONTROL_HTTP_PREFIX}/disconnected`,
        method: isRpc ? 'POST' : 'PUT',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      });
      request.on('error', () => undefined);
      request.end(body);
      await vi.waitFor(() => {
        assert.equal(registry.listHumanControlHolds({ kind: 'host' })[0]?.state, 'activating');
      });
      request.destroy();
      await disconnected.promise;
      await vi.waitFor(() => {
        assert.deepEqual(registry.listHumanControlHolds({ kind: 'host' }), []);
      });
      assert.equal(mutationFinished, false);
      finish.resolve();
      await mutation;
      assert.deepEqual(registry.listHumanControlHolds({ kind: 'host' }), []);
      assert.equal(await registry.runDeviceMutation(lease, async () => 'resumed'), 'resumed');
    } finally {
      request?.destroy();
      finish.resolve();
      await mutation;
      await closeLoopbackServer(server);
    }
  });
}

test('host administration and tenant RPC use the same lease registry with distinct authority', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { registry, lease, handleRequest } = createHumanControlHarness();
  const server = await createDaemonHttpServer({
    token: 'test-token',
    leaseRegistry: registry,
    handleRequest,
  });
  try {
    const port = await listenOnLoopback(server);
    const origin = `http://127.0.0.1:${String(port)}`;
    const baseUrl = origin + HUMAN_CONTROL_HTTP_PREFIX;
    const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const denied = await fetch(baseUrl, { headers: { authorization: 'Bearer tenant-credential' } });
    assert.equal(denied.status, 401);
    const invalid = await fetch(baseUrl + '/console', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ scope: { deviceKey: 'sim-1' } }),
    });
    assert.equal(invalid.status, 400);
    const created = await fetch(baseUrl + '/host', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ scope: HUMAN_CONTROL_SCOPE }),
    });
    assert.equal(created.status, 200);
    const body = (await created.json()) as { state: string; hold: { scope: unknown } };
    assert.equal(body.state, 'active');
    assert.deepEqual(body.hold.scope, HUMAN_CONTROL_SCOPE);

    const rpc = async (command: string, positionals: string[]) => {
      const request = humanControlRequest(lease, command, positionals);
      return await fetch(origin + '/rpc', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'takeover-rpc',
          method: 'agent_device.command',
          params: request,
        }),
      });
    };
    assert.equal((await rpc('human_control', ['put', 'tenant', '{}'])).status, 200);
    const blocked = await rpc('click', ['10', '10']);
    assert.equal(blocked.status, 423);
    assert.match(JSON.stringify(await blocked.json()), /human_control_active/);
    assert.equal((await rpc('snapshot', [])).status, 200);
    assert.equal((await rpc('human_control', ['remove', 'host'])).status, 401);
    assert.equal((await rpc('human_control', ['remove', 'tenant'])).status, 200);
    assert.equal((await rpc('click', ['10', '10'])).status, 423);

    const listed = await fetch(baseUrl, { headers });
    assert.equal(listed.status, 200);
    assert.equal(((await listed.json()) as { holds: unknown[] }).holds.length, 1);
    const released = await fetch(baseUrl + '/host', { method: 'DELETE', headers });
    assert.equal(released.status, 200);
    assert.deepEqual(registry.listHumanControlHolds({ kind: 'host' }), []);
  } finally {
    await closeLoopbackServer(server);
  }
});
