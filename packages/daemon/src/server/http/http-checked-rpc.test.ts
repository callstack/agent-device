import { test } from 'vitest';
import assert from 'node:assert/strict';
import type http from 'node:http';
import { createDaemonHttpServer } from './http-server.ts';
import { refuseUnservedCheckedRequest } from './http-checked-rpc.ts';
import {
  DAEMON_HTTP_CHECKED_RPC_CAPABILITY,
  DAEMON_HTTP_CHECKED_RPC_ROUTE,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

type RpcError = {
  error?: { data?: { code?: string; details?: Record<string, unknown> } };
};

test('the checked route authenticates, then refuses protocol skew before dispatch', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let handlerCalls = 0;
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async () => {
      handlerCalls += 1;
      return { ok: true, data: {} };
    },
    env: process.env,
    cwd: process.cwd(),
  });
  try {
    const endpoint = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const health = (await (await fetch(`${endpoint}/health`)).json()) as { capabilities: string[] };
    assert.ok(health.capabilities.includes(DAEMON_HTTP_CHECKED_RPC_CAPABILITY));
    const checked = (protocol: string | undefined, token = 'daemon-secret') =>
      fetch(`${endpoint}${DAEMON_HTTP_CHECKED_RPC_ROUTE}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(protocol === undefined ? {} : { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: protocol }),
        },
        // A method this build does not know: the skew answer must not depend on decoding it.
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'req-1',
          method: 'agent_device.future_method',
          params: { command: 'devices' },
        }),
      });

    const unauthenticated = await checked('999', 'wrong-token');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get(DAEMON_HTTP_REFUSAL_HEADER), null);
    assert.equal(
      ((await unauthenticated.json()) as RpcError).error?.data?.details?.version,
      undefined,
    );

    const skewed = await checked('999');
    assert.equal(skewed.status, 409);
    assert.equal(skewed.headers.get(DAEMON_HTTP_REFUSAL_HEADER), 'protocol-mismatch');
    const details = ((await skewed.json()) as RpcError).error?.data?.details;
    assert.equal(details?.reason, 'remote_rpc_protocol_mismatch');
    assert.equal(details?.service, 'agent-device-daemon');
    assert.equal(details?.rpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
    assert.equal(details?.dispatched, 'no');

    const missing = await checked(undefined);
    assert.equal(missing.status, 409);
    assert.equal(missing.headers.get(DAEMON_HTTP_REFUSAL_HEADER), 'protocol-missing');
    assert.equal(handlerCalls, 0);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a matching checked call runs exactly like /rpc', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const commands: string[] = [];
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (request) => {
      commands.push(request.command);
      return { ok: true, data: { echoed: request.command } };
    },
    env: process.env,
    cwd: process.cwd(),
  });
  try {
    const endpoint = `http://127.0.0.1:${await listenOnLoopback(server)}`;
    const response = await fetch(`${endpoint}${DAEMON_HTTP_CHECKED_RPC_ROUTE}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer daemon-secret',
        [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: String(DAEMON_RPC_PROTOCOL_VERSION),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'agent_device.command',
        params: { command: 'devices', positionals: [] },
      }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result?: { data?: { echoed?: string } } };
    assert.equal(body.result?.data?.echoed, 'devices');
    assert.deepEqual(commands, ['devices']);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a checked script recording needs the script-artifacts capability before dispatch', () => {
  const written: { status?: number; headers: Record<string, unknown>; body?: string } = {
    headers: {},
  };
  const res = {
    setHeader: (name: string, value: unknown) => {
      written.headers[name] = value;
    },
    set statusCode(value: number) {
      written.status = value;
    },
    end: (body: string) => {
      written.body = body;
    },
  } as unknown as http.ServerResponse;
  const recording = {
    token: '',
    session: 'default',
    command: 'open',
    positionals: [],
    meta: { scriptPublicationId: 'publication-1' },
  };
  assert.equal(refuseUnservedCheckedRequest(res, 'req-3', recording, ['script-artifacts']), false);
  assert.equal(refuseUnservedCheckedRequest(res, 'req-3', { ...recording, meta: {} }, []), false);

  assert.equal(refuseUnservedCheckedRequest(res, 'req-3', recording, []), true);
  assert.equal(written.status, 409);
  assert.equal(written.headers[DAEMON_HTTP_REFUSAL_HEADER], 'script-artifacts');
  const details = (JSON.parse(written.body ?? '{}') as RpcError).error?.data?.details;
  assert.equal(details?.reason, 'remote_script_artifacts_unsupported');
});
