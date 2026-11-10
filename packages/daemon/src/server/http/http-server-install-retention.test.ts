import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  closeLoopbackServer,
  createLiveTestHostEnvironment,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { SessionStore } from '../../core/session-store.ts';
import {
  cleanupUploadedArtifact,
  prepareUploadedArtifact,
  trackUploadedArtifact,
} from '../../resources/artifact-tracking.ts';
import { handleInstallFromSourceDeploymentCommand } from '../../sessions/handlers/session-app-source-deployment.ts';
import { createDaemonHttpServer } from './http-server.ts';

async function callRpc(port: number, method: string, params: Record<string, unknown>) {
  return await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'retention', method, params }),
  });
}

test('HTTP install retention rejects supplied invalid values before dispatch and preserves valid values', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'HTTP install retention')) return;
  const received: unknown[] = [];
  const server = await createDaemonHttpServer({
    token: 'test-token',
    ...createLiveTestHostEnvironment(),
    handleRequest: async (req) => {
      received.push(req.meta?.materializedPathRetentionMs);
      return { ok: true, data: {} };
    },
  });
  try {
    const port = await listenOnLoopback(server);
    const params = {
      platform: 'android',
      source: { kind: 'url', url: 'https://example.com/app.apk' },
      retainPaths: true,
    };
    for (const retentionMs of [1.5, 0, -1, 2_147_483_648, '60000', null]) {
      const response = await callRpc(port, 'agent_device.install_from_source', {
        ...params,
        retentionMs,
      });
      assert.equal(response.status, 400);
      const body = (await response.json()) as { error?: { data?: { code?: string } } };
      assert.equal(body.error?.data?.code, 'INVALID_ARGS');
    }
    assert.deepEqual(received, []);
    for (const retentionMs of [1, 2_147_483_647, undefined]) {
      const response = await callRpc(port, 'agent_device.install_from_source', {
        ...params,
        retentionMs,
      });
      assert.equal(response.status, 200);
      await response.json();
    }
    assert.deepEqual(received, [1, 2_147_483_647, undefined]);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('HTTP install rejection leaves an uploaded artifact available', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'HTTP install retention')) return;
  const host = createLiveTestHostEnvironment();
  const root = mkdtempForTestSync('agent-device-retention-upload-');
  const tempDir = path.join(root, 'upload');
  fs.mkdirSync(tempDir);
  const artifactPath = path.join(tempDir, 'app.apk');
  fs.writeFileSync(artifactPath, 'uploaded-apk');
  const uploadId = trackUploadedArtifact({ artifactPath, tempDir });
  const sessionStore = new SessionStore(path.join(root, 'sessions'), host);
  const server = await createDaemonHttpServer({
    token: 'test-token',
    ...host,
    handleRequest: async (req) =>
      await handleInstallFromSourceDeploymentCommand({
        req,
        sessionName: req.session ?? 'default',
        sessionStore,
        platformServices: daemonPlatformServicesFixture(),
      }),
  });
  try {
    const port = await listenOnLoopback(server);
    const response = await callRpc(port, 'agent_device.command', {
      command: 'install_source',
      flags: { platform: 'android' },
      meta: {
        installSource: { kind: 'path', path: 'uploaded.apk' },
        uploadedArtifactId: uploadId,
        retainMaterializedPaths: true,
        materializedPathRetentionMs: 1.5,
      },
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: { data?: { code?: string } } };
    assert.equal(body.error?.data?.code, 'INVALID_ARGS');
    assert.equal(prepareUploadedArtifact(uploadId), artifactPath);
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'uploaded-apk');
  } finally {
    cleanupUploadedArtifact(uploadId);
    await closeLoopbackServer(server);
  }
});
