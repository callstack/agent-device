import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { HUMAN_CONTROL_HTTP_PREFIX, HumanControlRegistry } from '../human-control.ts';
import { createDaemonHttpServer } from '../server/http-server.ts';

test('daemon human-control API authenticates and manages persistent holds', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const registry = new HumanControlRegistry();
  let releasedHoldId: string | undefined;
  let handlerCalls = 0;
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    humanControlRegistry: registry,
    onHumanControlHoldReleased: (hold) => {
      releasedHoldId = hold.id;
    },
    handleRequest: async (request) => {
      handlerCalls += 1;
      if (request.command === 'click') {
        return {
          ok: false,
          error: {
            code: 'DEVICE_IN_USE',
            message:
              'A human is interacting with this simulator or device; agent interactions are temporarily disabled.',
            details: { reason: 'human_control_active' },
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${String(port)}${HUMAN_CONTROL_HTTP_PREFIX}`;
    const unauthorized = await fetch(baseUrl);
    assert.equal(unauthorized.status, 401);
    assert.deepEqual(await unauthorized.json(), {
      ok: false,
      error: 'Invalid token',
      code: 'UNAUTHORIZED',
    });

    const malformedHoldId = await fetch(`${baseUrl}/%`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer daemon-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ scope: { deviceKey: 'sim-1' } }),
    });
    assert.equal(malformedHoldId.status, 400);
    assert.equal(((await malformedHoldId.json()) as { code?: string }).code, 'INVALID_ARGS');

    const socketOnlyRpc = await fetch(`http://127.0.0.1:${String(port)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'human-control-rpc',
        method: 'agent_device.command',
        params: {
          token: 'daemon-secret',
          command: 'human_control',
          positionals: ['list'],
        },
      }),
    });
    assert.equal(socketOnlyRpc.status, 404);
    assert.match(JSON.stringify(await socketOnlyRpc.json()), /socket-only/);

    const created = await fetch(`${baseUrl}/vm-console`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer daemon-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        scope: {
          deviceKey: 'sim-1',
          deviceName: 'iPhone 17 Pro',
          platform: 'ios',
          kind: 'simulator',
        },
        reason: 'Human is using the VM console.',
      }),
    });
    assert.equal(created.status, 200);
    const createdBody = (await created.json()) as {
      hold?: { id?: string; expiresAt?: number };
      state?: string;
    };
    assert.equal(createdBody.hold?.id, 'vm-console');
    assert.equal(createdBody.hold?.expiresAt, undefined);
    assert.equal(createdBody.state, 'active');

    const blockedRpc = await fetch(`http://127.0.0.1:${String(port)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'blocked-click',
        method: 'agent_device.command',
        params: {
          token: 'daemon-secret',
          command: 'click',
          positionals: ['10', '10'],
        },
      }),
    });
    assert.equal(blockedRpc.status, 423);
    assert.match(JSON.stringify(await blockedRpc.json()), /DEVICE_IN_USE/);

    const listed = await fetch(baseUrl, {
      headers: { 'x-agent-device-token': 'daemon-secret' },
    });
    assert.equal(listed.status, 200);
    const listedBody = (await listed.json()) as { holds?: Array<{ id?: string }> };
    assert.deepEqual(
      listedBody.holds?.map((hold) => hold.id),
      ['vm-console'],
    );

    const removed = await fetch(`${baseUrl}/vm-console`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer daemon-secret' },
    });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { released?: boolean }).released, true);
    assert.equal(releasedHoldId, 'vm-console');
    assert.equal(handlerCalls, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});
