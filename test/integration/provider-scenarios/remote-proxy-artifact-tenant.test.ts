import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../../../src/agent-device-client.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '@agent-device/daemon/testing/artifact-tracking';
import { finalizeDaemonResponse } from '@agent-device/daemon/testing/request-finalization';
import { createDaemonHttpServer } from '@agent-device/daemon/testing/server/http-server';
import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { normalizeAgentDeviceError } from '@agent-device/kernel/errors';
import { downloadRemoteArtifact } from '../../../src/remote/daemon-artifacts.ts';
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
  const remoteScreenshotPath = path.join(tempDir, 'remote-shot.png');
  const localScreenshotPath = path.join(tempDir, 'local-shot.png');
  const rejectedScreenshotPath = path.join(tempDir, 'rejected-shot.png');
  fs.writeFileSync(remoteScreenshotPath, 'tenant-scoped-png');
  const artifactIds: string[] = [];
  const upstream = await createDaemonHttpServer({
    token: 'upstream-token',
    handleRequest: async (req) => {
      assert.equal(req.command, 'screenshot');
      assert.equal(req.meta?.tenantId, TENANT);
      assert.equal(req.meta?.runId, 'local-proxy-run');
      assert.equal(req.meta?.sessionIsolation, 'tenant');
      return finalizeDaemonResponse(
        req,
        { ok: true, data: { path: remoteScreenshotPath } },
        (artifact) => {
          const artifactId = trackDownloadableArtifact(artifact);
          artifactIds.push(artifactId);
          return artifactId;
        },
      );
    },
  });
  const protectedArtifactId = trackDownloadableArtifact({
    artifactPath: remoteScreenshotPath,
    tenantId: TENANT,
    artifactType: 'screenshot',
    fileName: 'remote-shot.png',
  });
  artifactIds.push(protectedArtifactId);
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

    const client = createAgentDeviceClient({
      daemonBaseUrl,
      daemonAuthToken: 'proxy-token',
      tenant: TENANT,
      runId: 'local-proxy-run',
      sessionIsolation: 'tenant',
      stateDir: tempDir,
    });
    const screenshot = await client.capture.screenshot({ path: localScreenshotPath });

    assert.equal(screenshot.path, localScreenshotPath);
    assert.equal(fs.readFileSync(localScreenshotPath, 'utf8'), 'tenant-scoped-png');
  } finally {
    for (const artifactId of artifactIds) cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Provider-backed integration authenticated proxy sends every admitted RPC method as the caller tenant', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'authenticated proxy rpc tenant coverage')) return;

  const observed: DaemonWireRequest[] = [];
  const upstream = await createDaemonHttpServer({
    token: 'upstream-token',
    handleRequest: async (req): Promise<DaemonResponse> => {
      observed.push(req);
      return { ok: true, data: {} };
    },
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
      assert.equal(observed.at(-1)?.meta?.tenantId, 'alice', method);
    }
    assert.equal(observed[0]?.meta?.sessionIsolation, 'tenant');

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
