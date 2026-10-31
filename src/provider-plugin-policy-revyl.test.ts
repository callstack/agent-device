import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, test } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { resolveProviderPlugins, startProviderRegistry } from '@agent-device/plugins/registry';
import revyl from '@agent-device/revyl';
import { PROVIDER_PLUGIN_POLICY } from './provider-plugin-policy.ts';

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A Revyl backend that rents one device and then refuses every `/stop`. */
async function backendThatCannotStop(): Promise<string> {
  let sessionId = '';
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '';
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (url.endsWith('/start_device')) {
        sessionId = JSON.parse(Buffer.concat(chunks).toString('utf8')).session_id;
        return reply(200, { workflow_run_id: 'run-1', session_id: sessionId });
      }
      if (url.includes('/worker-connection/')) {
        return reply(200, { status: 'ready', worker_ws_url: 'wss://worker.test/ws' });
      }
      if (url.endsWith('/health')) {
        return reply(200, { device_connected: true, screen_width: 390, screen_height: 844 });
      }
      if (url.endsWith('/stop')) return reply(500, { detail: 'backend down' });
      return reply(404, { detail: `no route for ${url}` });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test('a Revyl device the shutdown could not stop is named in the message and hint the host keeps', async () => {
  const apiUrl = await backendThatCannotStop();
  const resolved = await resolveProviderPlugins([
    { source: 'embedder', provider: 'revyl', load: () => revyl({ apiKey: 'test-key', apiUrl }) },
  ]);
  const registry = await startProviderRegistry(resolved, {}, PROVIDER_PLUGIN_POLICY);
  const runtime = registry.registrations[0]!.runtime;
  const lease: DeviceLease = {
    leaseId: 'lease-1',
    tenantId: 'tenant',
    runId: 'run',
    backend: 'ios-instance',
    leaseProvider: 'revyl',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const allocated = await runtime.leaseLifecycle?.allocate?.(lease);
  const sessionId = String(allocated?.providerSessionId);

  const [outcome] = await registry.close();

  assert.equal(outcome?.shutdown.status, 'failed');
  const failure = outcome?.shutdown.status === 'failed' ? outcome.shutdown.error : undefined;
  assert.equal(failure?.reason, 'provider-cleanup-pending');
  assert.match(failure?.message ?? '', new RegExp(sessionId));
  assert.match(failure?.hint ?? '', new RegExp(sessionId));
});
