import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { DaemonRequest } from '../../daemon/daemon-request.ts';
import { createDaemonHttpServer } from '../../daemon/server/http-server.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { createHostServer } from './host-server.ts';
import { prepareHostServiceCredential } from './service-credential.ts';

const DAEMON_TOKEN = 'daemon-token-never-leaves-host';

/** Host in front of a real daemon HTTP server whose handler records what the daemon admitted. */
async function startHostOverDaemon(t: TestContext) {
  const admitted: DaemonRequest[] = [];
  const env = { ...process.env };
  delete env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  delete env.AGENT_DEVICE_HTTP_AUTH_EXPORT;
  const daemon = await createDaemonHttpServer({
    token: DAEMON_TOKEN,
    env,
    handleRequest: async (request) => {
      admitted.push(request);
      return { ok: true, data: {} };
    },
  });
  const daemonPort = await listenOnLoopback(daemon);
  t.onTestFinished(() => closeLoopbackServer(daemon));
  const prepared = prepareHostServiceCredential(
    path.join(mkdtempForTestSync('agent-device-host-policy-'), 'host'),
  );
  prepared.publish();
  const { credential } = prepared;
  const host = createHostServer({
    upstreamBaseUrl: `http://127.0.0.1:${daemonPort}`,
    upstreamToken: DAEMON_TOKEN,
    credential,
  });
  const hostPort = await listenOnLoopback(host);
  t.onTestFinished(() => closeLoopbackServer(host));
  const baseUrl = `http://127.0.0.1:${hostPort}/agent-device`;
  const rpc = async (
    method: string,
    params: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential.token}`,
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'host-policy', method, params }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const command = (params: Record<string, unknown>, headers?: Record<string, string>) =>
    rpc('agent_device.command', { positionals: [], flags: {}, ...params }, headers);
  return { admitted, credential, baseUrl, rpc, command };
}

function assertRefused(
  response: { status: number; body: Record<string, any> },
  reason: string,
  admitted: readonly unknown[],
) {
  assert.equal(response.status, 403, JSON.stringify(response.body));
  assert.equal(response.body.error?.data?.code, 'UNSUPPORTED_OPERATION');
  assert.equal(response.body.error?.data?.details?.reason, reason);
  assert.equal(admitted.length, 0, 'a refused request must never reach the daemon');
}

test('a client-sent principal header is replaced by the server principal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  const response = await host.command(
    { command: 'devices' },
    { 'x-agent-device-principal': 'host-svc-attacker' },
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(host.admitted[0]?.internal?.hostPrincipal, host.credential.principal);
  assert.equal(host.admitted[0]?.meta?.tenantId, host.credential.principal);
});

test('a client tenant header is dropped and the daemon isolates the server principal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  await host.command({ command: 'devices' }, { 'x-agent-device-tenant': 'someone-else' });

  assert.equal(host.admitted[0]?.meta?.tenantId, host.credential.principal);
  assert.equal(host.admitted[0]?.meta?.sessionIsolation, 'tenant');
});

test('tenant claims in the command body are dropped', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  await host.command({
    command: 'devices',
    meta: { tenantId: 'someone-else', sessionIsolation: 'none' },
    flags: { tenant: 'someone-else' },
  });

  const admitted = host.admitted[0];
  assert.equal(admitted?.meta?.tenantId, host.credential.principal);
  assert.equal(admitted?.meta?.sessionIsolation, 'tenant');
  assert.equal(admitted?.flags?.tenant, undefined);
});

test('a tenant claim on a lease method is dropped', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  await host.rpc('agent_device.lease.allocate', {
    tenant: 'someone-else',
    tenantId: 'someone-else',
    runId: 'verify-812',
  });

  assert.equal(host.admitted[0]?.meta?.tenantId, host.credential.principal);
  assert.equal(host.admitted[0]?.meta?.runId, 'verify-812');
});

test('administration routes are refused with a typed reason', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  for (const route of ['/admin/leases', '/admin/human-control/holds']) {
    const response = await fetch(`${host.baseUrl}${route}`, {
      headers: { authorization: `Bearer ${host.credential.token}` },
    });
    const body = (await response.json()) as Record<string, any>;
    assert.equal(response.status, 403, route);
    assert.equal(body.details?.reason, 'host-admin-refused', route);
  }
});

test('allocating a host-administered macos-app lease is refused', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  const response = await host.rpc('agent_device.lease.allocate', {
    runId: 'verify-812',
    backend: 'macos-app',
  });

  assertRefused(response, 'host-admin-refused', host.admitted);
});

test('an install source naming a Host path is refused', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  const response = await host.command({
    command: 'install_source',
    meta: { installSource: { kind: 'path', path: '/Users/operator/app.ipa' } },
  });

  assertRefused(response, 'host-path-refused', host.admitted);
});

test('a flag naming a Host path is refused, and a daemon temp artifact location is not', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  const refused = await host.command({
    command: 'screenshot',
    flags: { out: '/Users/operator/.ssh/id_ed25519' },
  });
  assertRefused(refused, 'host-path-refused', host.admitted);

  const accepted = await host.command({
    command: 'screenshot',
    flags: { out: '/tmp/agent-device-screenshot-1767225600000-k3x9qa.png' },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
});

test('a request that asks the allocator to download components is refused', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  const response = await host.rpc('agent_device.lease.allocate', {
    runId: 'verify-812',
    allowDownload: true,
  });

  assertRefused(response, 'host-component-download-refused', host.admitted);
});

test('anonymous health is minimal and authenticated health names the Host', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const host = await startHostOverDaemon(t);

  const anonymous = await (await fetch(`${host.baseUrl}/health`)).json();
  assert.deepEqual(Object.keys(anonymous as object).sort(), [
    'ok',
    'rpcProtocolVersion',
    'service',
  ]);
  assert.equal((anonymous as Record<string, unknown>).service, 'agent-device-host');

  const authenticated = (await (
    await fetch(`${host.baseUrl}/health`, {
      headers: { authorization: `Bearer ${host.credential.token}` },
    })
  ).json()) as Record<string, any>;
  assert.equal(authenticated.service, 'agent-device-host');
  assert.equal(authenticated.upstream?.service, 'agent-device-daemon');
});
