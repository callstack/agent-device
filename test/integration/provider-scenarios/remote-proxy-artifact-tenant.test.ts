import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import { createAgentDeviceClient } from '../../../src/agent-device-client.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../../../src/daemon/artifact-tracking.ts';
import { finalizeDaemonResponse } from '../../../src/daemon/request-finalization.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import { normalizeAgentDeviceError } from '../../../src/kernel/errors.ts';
import { downloadRemoteArtifact } from '../../../src/remote/daemon-artifacts.ts';
import { createDaemonProxyServer } from '../../../src/remote/daemon-proxy.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

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
