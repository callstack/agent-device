import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDaemonHttpServer } from './http-server.ts';
import {
  DAEMON_HTTP_CHECKED_RPC_CAPABILITY,
  DAEMON_HTTP_CHECKED_RPC_ROUTE,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_HTTP_TENANT_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

type RpcError = {
  error?: { data?: { code?: string; details?: Record<string, unknown> } };
};

const PROTOCOL = String(DAEMON_RPC_PROTOCOL_VERSION);

/** A daemon whose handler counts dispatches, optionally behind an auth hook module. */
async function checkedDaemon(hookSource?: string) {
  let handlerCalls = 0;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (hookSource) {
    const hookPath = path.join(mkdtempForTestSync('checked-rpc-hook-'), 'hook.mjs');
    fs.writeFileSync(hookPath, hookSource);
    env.AGENT_DEVICE_HTTP_AUTH_HOOK = hookPath;
  }
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (request) => {
      handlerCalls += 1;
      return { ok: true, data: { echoed: request.command } };
    },
    env,
    cwd: process.cwd(),
  });
  const endpoint = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const call = (options: {
    protocol?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
    route?: string;
  }) =>
    fetch(`${endpoint}${options.route ?? DAEMON_HTTP_CHECKED_RPC_ROUTE}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token ?? 'daemon-secret'}`,
        ...(options.protocol === undefined
          ? {}
          : { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: options.protocol }),
        ...options.headers,
      },
      body:
        typeof options.body === 'string'
          ? options.body
          : JSON.stringify(
              options.body ?? {
                jsonrpc: '2.0',
                id: 'req-1',
                method: 'agent_device.command',
                params: { command: 'devices', positionals: [], session: 'owned' },
              },
            ),
    });
  return {
    endpoint,
    call,
    handlerCalls: () => handlerCalls,
    close: () => closeLoopbackServer(server),
  };
}

async function details(response: Response): Promise<Record<string, unknown> | undefined> {
  return ((await response.json()) as RpcError).error?.data?.details;
}

test('the checked route runs the /rpc gates, then refuses protocol skew with the daemon side', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemon = await checkedDaemon();
  try {
    const health = (await (await fetch(`${daemon.endpoint}/health`)).json()) as {
      capabilities: string[];
    };
    assert.ok(health.capabilities.includes(DAEMON_HTTP_CHECKED_RPC_CAPABILITY));

    const unauthenticated = await daemon.call({ protocol: '999', token: 'wrong-token' });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get(DAEMON_HTTP_REFUSAL_HEADER), null);

    const skewed = await daemon.call({ protocol: '999' });
    assert.equal(skewed.status, 409);
    assert.equal(skewed.headers.get(DAEMON_HTTP_REFUSAL_HEADER), 'protocol-mismatch');
    assert.deepEqual(
      { ...(await details(skewed)), version: undefined },
      {
        reason: 'remote_rpc_protocol_mismatch',
        dispatched: 'no',
        service: 'agent-device-daemon',
        version: undefined,
        rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      },
    );

    const missing = await daemon.call({});
    assert.equal(missing.status, 409);
    assert.equal(missing.headers.get(DAEMON_HTTP_REFUSAL_HEADER), 'protocol-missing');
    assert.equal(daemon.handlerCalls(), 0);
  } finally {
    await daemon.close();
  }
});

test('the auth hook sees the real request on the checked route and its denial wins over skew', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // Denies every session but `default`, so a hook shown a stand-in request would admit the caller.
  const daemon = await checkedDaemon(
    "export default ({ daemonRequest }) => daemonRequest.session === 'default';\n",
  );
  try {
    const denied = await daemon.call({ protocol: '999' });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get(DAEMON_HTTP_REFUSAL_HEADER), null);
    assert.equal((await details(denied))?.version, undefined);
  } finally {
    await daemon.close();
  }
});

test('an unattested tenant gets the /rpc tenant refusal on the checked route, not the version', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  // Admits the caller but attests no tenant, so a client-declared tenant fails tenant trust.
  const daemon = await checkedDaemon('export default () => true;\n');
  try {
    const refused = await daemon.call({
      protocol: '999',
      headers: { [DAEMON_HTTP_TENANT_HEADER]: 'tenant-a' },
      body: {
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'agent_device.command',
        params: { command: 'devices', positionals: [], meta: { tenantId: 'tenant-a' } },
      },
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get(DAEMON_HTTP_REFUSAL_HEADER), null);
  } finally {
    await daemon.close();
  }
});

test('a skewed call this build cannot decode is refused without the daemon version', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemon = await checkedDaemon();
  try {
    const refused = await daemon.call({
      protocol: '999',
      body: { jsonrpc: '2.0', id: 'req-3', method: 'agent_device.future_method', params: {} },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.headers.get(DAEMON_HTTP_REFUSAL_HEADER), 'protocol-mismatch');
    const refusal = await details(refused);
    assert.equal(refusal?.reason, 'remote_rpc_protocol_mismatch');
    assert.equal(refusal?.version, undefined);
    assert.equal(refusal?.service, undefined);
    assert.equal(daemon.handlerCalls(), 0);
  } finally {
    await daemon.close();
  }
});

test('a matching checked call runs exactly like /rpc', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const daemon = await checkedDaemon();
  try {
    const response = await daemon.call({ protocol: PROTOCOL });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result?: { data?: { echoed?: string } } };
    assert.equal(body.result?.data?.echoed, 'devices');
    assert.equal(daemon.handlerCalls(), 1);
  } finally {
    await daemon.close();
  }
});
