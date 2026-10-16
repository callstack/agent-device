import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { normalizeAgentDeviceError } from '@agent-device/kernel/errors';
import { downloadRemoteArtifact } from '@agent-device/remote/daemon-artifacts';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

const TENANT = 'local-proxy-tenant';
const OTHER_TENANT = 'other-tenant';

test('Provider-backed integration local proxy materializes tenant-scoped screenshots', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'local proxy artifact tenant coverage')) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-proxy-artifact-tenant-'));
  const localScreenshotPath = path.join(tempDir, 'local-shot.png');
  const rejectedScreenshotPath = path.join(tempDir, 'rejected-shot.png');
  const protectedArtifactId = 'protected-screenshot';
  const upstream = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer upstream-token');
    assert.equal(request.url, `/artifacts/${protectedArtifactId}`);
    if (request.headers['x-agent-device-tenant'] !== TENANT) {
      response.statusCode = 401;
      response.end('Artifact belongs to a different tenant');
      return;
    }
    response.statusCode = 200;
    response.end('tenant-scoped-png');
  });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'upstream-token',
    clientToken: 'proxy-token',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const daemonBaseUrl = `http://127.0.0.1:${proxyPort}/agent-device`;

    await assert.rejects(
      async () =>
        await downloadRemoteArtifact({
          baseUrl: daemonBaseUrl,
          token: 'proxy-token',
          artifactId: protectedArtifactId,
          destinationPath: rejectedScreenshotPath,
          requestScope: { tenantId: OTHER_TENANT },
        }),
      (error: unknown) => {
        const normalized = normalizeAgentDeviceError(error);
        assert.equal(normalized.details?.statusCode, 401);
        assert.match(String(normalized.details?.body), /different tenant/i);
        return true;
      },
    );
    assert.equal(fs.existsSync(rejectedScreenshotPath), false);

    await downloadRemoteArtifact({
      baseUrl: daemonBaseUrl,
      token: 'proxy-token',
      artifactId: protectedArtifactId,
      destinationPath: localScreenshotPath,
      requestScope: { tenantId: TENANT },
    });

    assert.equal(fs.readFileSync(localScreenshotPath, 'utf8'), 'tenant-scoped-png');
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Provider-backed integration authenticated proxy sends every admitted RPC method as the caller tenant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'authenticated proxy rpc tenant coverage')) return;

  const observed: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/rpc') {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id: string | number;
      method: string;
      params: Record<string, unknown>;
    };
    observed.push(payload);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { ok: true, data: {} } }),
    );
  });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'upstream-token',
    authenticate: (request) =>
      request.headers.get('authorization') === 'Bearer alice-key' ? { tenantId: 'alice' } : null,
  });
  const otherTenantParams = { session: 'bob:default', tenantId: 'bob', runId: 'run-1' };
  const admitted: Array<[string, Record<string, unknown>]> = [
    ['agent_device.command', { command: 'devices', meta: { tenantId: 'bob' } }],
    ['agent_device.lease.allocate', { backend: 'ios-simulator' }],
    ['agent_device.lease.heartbeat', { leaseId: 'lease-1' }],
    ['agent_device.lease.release', { leaseId: 'lease-1' }],
  ];
  const refused: Array<[string, Record<string, unknown>]> = [
    [
      'agent_device.install_from_source',
      { platform: 'ios', source: { kind: 'url', url: 'https://example.test/app.ipa' } },
    ],
    ['agent_device.release_materialized_paths', { materializationId: 'materialization-1' }],
  ];

  try {
    const rpcUrl = `http://127.0.0.1:${await listenOnLoopback(proxy)}/agent-device/rpc`;
    const call = async (method: string, params: Record<string, unknown>) =>
      await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer alice-key' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: method,
          method,
          params: { ...otherTenantParams, ...params },
        }),
      });

    for (const [method, params] of admitted) {
      const response = await call(method, params);
      assert.equal(response.status, 200, method);
      assert.equal(
        (observed.at(-1)?.params.meta as Record<string, unknown> | undefined)?.tenantId,
        'alice',
        method,
      );
    }
    assert.equal(
      (observed[0]?.params.meta as Record<string, unknown> | undefined)?.sessionIsolation,
      'tenant',
    );

    for (const [method, params] of refused) {
      const response = await call(method, params);
      assert.equal(response.status, 401, method);
    }
    assert.equal(observed.length, admitted.length);
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});
