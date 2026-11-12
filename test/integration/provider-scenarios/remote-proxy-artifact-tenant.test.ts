import type { DaemonWireRequest } from '@agent-device/contracts/command';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import https from 'node:https';
import path from 'node:path';
import { test } from 'vitest';
import { normalizeAgentDeviceError } from '@agent-device/kernel/errors';
import {
  downloadRemoteArtifact,
  materializeRemoteArtifacts,
} from '@agent-device/remote/daemon-artifacts';
import { skipWhenLoopbackUnavailable, createTestHostEnvironment } from '@agent-device/test-kit';
import { withProviderScenarioResource, withProviderScenarioTempDir } from './harness.ts';
import { createProviderScenarioProxy } from './harness-proxy.ts';
import { FAKE_PROVIDER, createFakeProviderWorld } from './provider-device-runtime.fixtures.ts';

const TENANT = 'local-proxy-tenant';
const OTHER_TENANT = 'other-tenant';
const TENANT_TOKEN = 'tenant-a-key';
const OTHER_TENANT_TOKEN = 'tenant-b-key';

function tenantAuthentication(request: Request) {
  const token = request.headers.get('authorization');
  if (token === `Bearer ${TENANT_TOKEN}`) return { tenantId: TENANT };
  if (token === `Bearer ${OTHER_TENANT_TOKEN}`) return { tenantId: OTHER_TENANT };
  return null;
}

test('Provider-backed integration proxy materializes tenant-owned test artifacts from the daemon route', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'local proxy artifact tenant coverage')) return;

  await withProviderScenarioResource(
    async () => await createFakeProviderWorld(),
    async ({ daemon }) => {
      await withProviderScenarioTempDir('agent-device-proxy-artifact-tenant-', async (tempDir) => {
        const sourceDir = path.join(tempDir, 'source');
        const daemonArtifactsRoot = path.join(tempDir, 'daemon-side');
        const clientRoot = path.join(tempDir, 'caller-side', 'artifacts');
        const scriptPath = path.join(sourceDir, 'flow.ad');
        const rejectedArchivePath = path.join(tempDir, 'rejected.tar.gz');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(scriptPath, '');
        const proxy = await createProviderScenarioProxy(daemon, {
          authenticate: tenantAuthentication,
        });
        try {
          const allocation = await proxy.requestRpc(TENANT_TOKEN, {
            jsonrpc: '2.0',
            id: 'tenant-artifact-lease',
            method: 'agent_device.lease.allocate',
            params: {
              tenantId: TENANT,
              runId: 'artifact-run',
              backend: 'android-instance',
              leaseProvider: FAKE_PROVIDER,
              platform: 'android',
              deviceKey: 'android-a',
              clientId: 'tenant-artifact-client',
            },
          });
          assert.equal(allocation.statusCode, 200, JSON.stringify(allocation.json));
          const leaseId = allocation.json.result?.data?.lease?.leaseId;
          assert.equal(typeof leaseId, 'string', JSON.stringify(allocation.json));
          const leaseScope = {
            leaseId,
            leaseBackend: 'android-instance',
            leaseProvider: FAKE_PROVIDER,
            deviceKey: 'android-a',
            clientId: 'tenant-artifact-client',
          } as const;
          const request: DaemonWireRequest = {
            token: TENANT_TOKEN,
            session: 'default',
            command: 'test',
            positionals: [scriptPath],
            flags: { artifactsDir: daemonArtifactsRoot },
            meta: {
              cwd: sourceDir,
              tenantId: TENANT,
              runId: 'artifact-run',
              requestId: 'tenant-artifact-run',
              ...leaseScope,
              clientArtifactPaths: { artifactsDir: clientRoot },
            },
          };

          const rpc = await proxy.callCommand(
            TENANT_TOKEN,
            request.command,
            request.positionals,
            request.flags,
            { meta: request.meta, session: request.session },
          );
          assert.equal(rpc.statusCode, 200, JSON.stringify(rpc.json));
          const data = rpc.json.result?.data as
            | {
                total?: number;
                passed?: number;
                failed?: number;
                artifacts?: Array<{ artifactId?: string; artifactType?: string }>;
              }
            | undefined;
          assert.equal(data?.total, 1, JSON.stringify(rpc.json));
          assert.equal(data?.passed, 1, JSON.stringify(rpc.json));
          assert.equal(data?.failed, 0, JSON.stringify(rpc.json));
          const artifact = data?.artifacts?.[0];
          assert.equal(artifact?.artifactType, 'test-artifacts');
          assert.equal(typeof artifact?.artifactId, 'string');
          const artifactId = artifact?.artifactId as string;

          const testRequest = proxy.forwarded.find((entry) => {
            if (entry.method !== 'POST' || entry.route !== '/rpc') return false;
            const payload = JSON.parse(entry.requestBody) as {
              params?: { command?: string };
            };
            return payload.params?.command === 'test';
          });
          assert.ok(testRequest, 'the test command did not reach the daemon');
          const forwardedParams = JSON.parse(testRequest.requestBody) as {
            params: { command?: string; tenantId?: string; meta?: Record<string, unknown> };
          };
          assert.equal(forwardedParams.params.command, 'test');
          assert.equal(forwardedParams.params.tenantId, TENANT);
          assert.equal(forwardedParams.params.meta?.tenantId, TENANT);
          assert.equal(testRequest.authorization, `Bearer ${daemon.token}`);
          assert.equal(testRequest.tenantId, TENANT);

          await assert.rejects(
            async () =>
              await downloadRemoteArtifact({
                baseUrl: proxy.baseUrl,
                token: OTHER_TENANT_TOKEN,
                artifactId,
                destinationPath: rejectedArchivePath,
                requestScope: { tenantId: OTHER_TENANT },
                isDirectory: true,
              }),
            (error: unknown) => {
              const normalized = normalizeAgentDeviceError(error);
              assert.equal(normalized.details?.statusCode, 401);
              return true;
            },
          );
          assert.deepEqual(fs.readdirSync(rejectedArchivePath), []);

          const response: Extract<DaemonResponse, { ok: true }> = {
            ok: true,
            data: data as NonNullable<Extract<DaemonResponse, { ok: true }>['data']>,
          };
          const materialized = await materializeRemoteArtifacts(
            { baseUrl: proxy.baseUrl, token: TENANT_TOKEN },
            request,
            response,
            createTestHostEnvironment(),
          );
          assert.equal(materialized.ok, true);
          if (!materialized.ok) return;
          const materializedSuiteDir = materialized.data?.artifactsDir;
          if (typeof materializedSuiteDir !== 'string') {
            throw new Error('the artifact route did not materialize a suite directory');
          }
          assert.equal(path.dirname(materializedSuiteDir), clientRoot);
          assert.ok(fs.existsSync(materializedSuiteDir));
          const attemptDir = path.join(materializedSuiteDir, 'flow.ad', 'attempt-1');
          assert.equal(fs.readFileSync(path.join(attemptDir, 'replay.ad'), 'utf8'), '');
          assert.match(
            fs.readFileSync(path.join(attemptDir, 'result.txt'), 'utf8'),
            /status: passed/,
          );

          const downloads = proxy.forwarded.filter(
            (entry) => entry.method === 'GET' && entry.route === `/artifacts/${artifactId}`,
          );
          assert.deepEqual(
            downloads.map((entry) => [entry.authorization, entry.tenantId, entry.statusCode]),
            [
              [`Bearer ${daemon.token}`, OTHER_TENANT, 401],
              [`Bearer ${daemon.token}`, TENANT, 200],
            ],
          );
        } finally {
          await proxy.close();
        }
      });
    },
  );
});

test('Provider-backed integration authenticated proxy stamps every admitted RPC method before the daemon handles it', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'authenticated proxy rpc tenant coverage')) return;

  await withProviderScenarioResource(createFakeProviderWorld, async ({ daemon }) => {
    const proxy = await createProviderScenarioProxy(daemon, {
      authenticate: (request) =>
        request.headers.get('authorization') === 'Bearer alice-key' ? { tenantId: 'alice' } : null,
    });
    const nextTenantParams = { session: 'default', tenantId: 'bob', runId: 'run-1' };
    const leaseOwnerScope = {
      leaseBackend: 'android-instance',
      leaseProvider: FAKE_PROVIDER,
      deviceKey: 'android-a',
      clientId: 'client-a',
    };
    const rpc = async (id: string, method: string, params: Record<string, unknown>) =>
      await proxy.requestRpc('alice-key', {
        jsonrpc: '2.0',
        id,
        method,
        params: { ...nextTenantParams, ...params },
      });

    try {
      const commandId = 'tenant-command';
      const command = await rpc(commandId, 'agent_device.command', {
        command: 'devices',
        positionals: [],
        flags: { tenant: 'bob', sessionIsolation: 'none' },
        meta: { tenantId: 'bob', sessionIsolation: 'none', requestId: commandId },
      });
      assert.equal(command.statusCode, 200, JSON.stringify(command.json));
      assert.equal(command.json.result?.ok, true, JSON.stringify(command.json));

      const allocationId = 'tenant-lease-allocate';
      const allocation = await rpc(allocationId, 'agent_device.lease.allocate', {
        backend: 'android-instance',
        leaseProvider: FAKE_PROVIDER,
        platform: 'android',
        deviceKey: 'android-a',
        clientId: 'client-a',
      });
      assert.equal(allocation.statusCode, 200, JSON.stringify(allocation.json));
      assert.equal(allocation.json.result?.ok, true, JSON.stringify(allocation.json));
      const leaseId = allocation.json.result?.data?.lease?.leaseId;
      assert.equal(typeof leaseId, 'string', JSON.stringify(allocation.json));

      const heartbeatId = 'tenant-lease-heartbeat';
      const heartbeat = await rpc(heartbeatId, 'agent_device.lease.heartbeat', {
        leaseId,
        ...leaseOwnerScope,
      });
      assert.equal(heartbeat.statusCode, 200, JSON.stringify(heartbeat.json));
      assert.equal(heartbeat.json.result?.ok, true, JSON.stringify(heartbeat.json));

      const releaseId = 'tenant-lease-release';
      const release = await rpc(releaseId, 'agent_device.lease.release', {
        leaseId,
        ...leaseOwnerScope,
      });
      assert.equal(release.statusCode, 200, JSON.stringify(release.json));
      assert.equal(release.json.result?.ok, true, JSON.stringify(release.json));

      for (const [id, method] of [
        [commandId, 'agent_device.command'],
        [allocationId, 'agent_device.lease.allocate'],
        [heartbeatId, 'agent_device.lease.heartbeat'],
        [releaseId, 'agent_device.lease.release'],
      ]) {
        const forwarded = proxy.forwarded.find((entry) => {
          if (entry.method !== 'POST' || entry.route !== '/rpc') return false;
          return (JSON.parse(entry.requestBody) as { id?: unknown }).id === id;
        });
        assert.ok(forwarded, `${method} was not forwarded to the daemon`);
        const payload = JSON.parse(forwarded.requestBody) as {
          method?: string;
          params?: Record<string, unknown>;
        };
        assert.equal(payload.method, method);
        assert.equal(payload.params?.tenantId, 'alice', method);
        assert.equal(payload.params?.token, daemon.token, method);
        assert.equal(forwarded.authorization, `Bearer ${daemon.token}`, method);
        assert.equal(forwarded.tenantId, 'alice', method);
        if (method === 'agent_device.command') {
          assert.equal((payload.params?.meta as Record<string, unknown>)?.tenantId, 'alice');
          assert.equal(
            (payload.params?.meta as Record<string, unknown>)?.sessionIsolation,
            'tenant',
          );
        }
      }

      const forwardedCount = proxy.forwarded.length;
      const refused = await Promise.all([
        rpc('tenant-install-refusal', 'agent_device.install_from_source', {
          platform: 'ios',
          source: { kind: 'url', url: 'https://example.test/app.ipa' },
        }),
        rpc('tenant-release-materialized-refusal', 'agent_device.release_materialized_paths', {
          materializationId: 'materialization-1',
        }),
      ]);
      assert.deepEqual(
        refused.map((response) => response.statusCode),
        [401, 401],
      );
      assert.equal(proxy.forwarded.length, forwardedCount);
    } finally {
      await proxy.close();
    }
  });
});

test('real HTTP proxy preserves resumable upload integrity and caller credentials', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'proxy resumable upload coverage')) return;
  await withProviderScenarioResource(createFakeProviderWorld, async ({ daemon }) => {
    const proxy = await createProviderScenarioProxy(daemon, { clientToken: TENANT_TOKEN });
    try {
      const content = Buffer.from('ABCDE');
      const auth = { authorization: `Bearer ${TENANT_TOKEN}` };
      const preflight = await fetch(`${proxy.baseUrl}/upload/preflight`, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json',
          'x-forwarded-proto': 'http, https',
        },
        body: JSON.stringify({
          uploadAttemptId: crypto.randomUUID(),
          sha256: crypto.createHash('sha256').update(content).digest('hex'),
          fileName: 'demo.apk',
          sizeBytes: 5,
          artifactType: 'file',
          platform: 'android',
        }),
      });
      assert.equal(preflight.status, 200);
      const ticket = (await preflight.json()) as {
        uploadId: string;
        upload: { url: string; headers: Record<string, string> };
      };
      const url = new URL(ticket.upload.url);
      assert.equal(url.origin, new URL(proxy.baseUrl).origin);
      assert.equal(url.pathname, `/agent-device/upload/direct/${ticket.uploadId}`);
      assert.equal(ticket.upload.headers.authorization, `Bearer ${TENANT_TOKEN}`);
      assert.ok(!JSON.stringify(ticket).includes(daemon.token));
      const first = await fetch(url, {
        method: 'PUT',
        headers: { ...ticket.upload.headers, 'content-range': 'bytes 0-1/5' },
        body: 'AB',
        redirect: 'manual',
      });
      assert.equal(first.status, 308);
      assert.equal(first.headers.get('x-upload-offset'), '2');
      const second = await fetch(url, {
        method: 'PUT',
        headers: { ...ticket.upload.headers, 'content-range': 'bytes 2-4/5' },
        body: 'CDE',
      });
      assert.equal(second.status, 200);
      const finalized = await fetch(`${proxy.baseUrl}/upload/finalize`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: ticket.uploadId }),
      });
      assert.equal(finalized.status, 200);
      const result = (await finalized.json()) as { ok: boolean; uploadId: string };
      assert.equal(result.ok, true);
      assert.ok(result.uploadId);
    } finally {
      await proxy.close();
    }
  });
});

test('real TLS proxy preserves resumable upload origin and integrity', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'TLS proxy resumable upload coverage')) return;
  const cert = fs.readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url));
  const key = fs.readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url));
  await withProviderScenarioResource(createFakeProviderWorld, async ({ daemon }) => {
    const proxy = await createProviderScenarioProxy(daemon, {
      clientToken: TENANT_TOKEN,
      tls: { cert, key },
    });
    const request = async (
      url: string,
      method: string,
      headers: Record<string, string>,
      body: string,
    ) =>
      await new Promise<{
        status: number;
        headers: import('node:http').IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const req = https.request(url, { method, headers, ca: cert }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
      });
    try {
      const auth = { authorization: `Bearer ${TENANT_TOKEN}` };
      const preflight = await request(
        `${proxy.baseUrl}/upload/preflight`,
        'POST',
        {
          ...auth,
          'content-type': 'application/json',
          'x-forwarded-proto': 'http, http, https',
          'x-forwarded-host': 'evil.example',
        },
        JSON.stringify({
          uploadAttemptId: crypto.randomUUID(),
          sha256: crypto.createHash('sha256').update('ABCDE').digest('hex'),
          fileName: 'demo.apk',
          sizeBytes: 5,
          artifactType: 'file',
          platform: 'android',
        }),
      );
      assert.equal(preflight.status, 200, preflight.body);
      const ticket = JSON.parse(preflight.body) as {
        uploadId: string;
        upload: { url: string; headers: Record<string, string> };
      };
      const url = new URL(ticket.upload.url);
      assert.equal(url.origin, new URL(proxy.baseUrl).origin);
      assert.equal(url.pathname, `/agent-device/upload/direct/${ticket.uploadId}`);
      assert.equal(ticket.upload.headers.authorization, `Bearer ${TENANT_TOKEN}`);
      assert.ok(!preflight.body.includes(daemon.token));
      const first = await request(
        url.href,
        'PUT',
        { ...ticket.upload.headers, 'content-range': 'bytes 0-1/5' },
        'AB',
      );
      assert.equal(first.status, 308);
      assert.equal(first.headers['x-upload-offset'], '2');
      const second = await request(
        url.href,
        'PUT',
        { ...ticket.upload.headers, 'content-range': 'bytes 2-4/5' },
        'CDE',
      );
      assert.equal(second.status, 200);
      const finalized = await request(
        `${proxy.baseUrl}/upload/finalize`,
        'POST',
        { ...auth, 'content-type': 'application/json' },
        JSON.stringify({ uploadId: ticket.uploadId }),
      );
      assert.equal(finalized.status, 200, finalized.body);
      const result = JSON.parse(finalized.body) as { ok: boolean; uploadId: string };
      assert.equal(result.ok, true);
      assert.ok(result.uploadId);
    } finally {
      await proxy.close();
    }
  });
});
