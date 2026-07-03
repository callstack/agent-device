import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDaemonHttpServer } from '../server/http-server.ts';
import {
  cleanupDownloadableArtifact,
  listDownloadableArtifacts,
  trackDownloadableArtifact,
} from '../artifact-tracking.ts';
import type { DaemonResponse } from '../types.ts';
import { runCmdSync, withCommandExecutorOverride } from '../../utils/exec.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/index.ts';

type ArtifactInventoryResponse = {
  artifacts: Array<{
    id: string;
    artifactType?: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    createdAt: string;
    expiresAt: string;
  }>;
};

test('downloadable artifact inventory is filtered by tenant', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-artifacts-tenants-'));
  const publicPath = path.join(tempDir, 'public.txt');
  const tenantAPath = path.join(tempDir, 'tenant-a.txt');
  const tenantBPath = path.join(tempDir, 'tenant-b.txt');
  fs.writeFileSync(publicPath, 'public');
  fs.writeFileSync(tenantAPath, 'tenant-a');
  fs.writeFileSync(tenantBPath, 'tenant-b');
  const artifactIds = [
    trackDownloadableArtifact({
      artifactPath: publicPath,
      artifactType: 'test-public-file',
      fileName: 'public.txt',
    }),
    trackDownloadableArtifact({
      artifactPath: tenantAPath,
      tenantId: 'tenant-a',
      artifactType: 'test-tenant-file',
      fileName: 'tenant-a.txt',
    }),
    trackDownloadableArtifact({
      artifactPath: tenantBPath,
      tenantId: 'tenant-b',
      artifactType: 'test-tenant-file',
      fileName: 'tenant-b.txt',
    }),
  ];

  try {
    assert.deepEqual(
      (await listDownloadableArtifacts()).map((artifact) => artifact.filename),
      ['public.txt'],
    );
    assert.deepEqual(
      (await listDownloadableArtifacts('tenant-a')).map((artifact) => artifact.filename),
      ['public.txt', 'tenant-a.txt'],
    );
    assert.deepEqual(
      (await listDownloadableArtifacts('tenant-b')).map((artifact) => artifact.filename),
      ['public.txt', 'tenant-b.txt'],
    );
  } finally {
    for (const artifactId of artifactIds) {
      cleanupDownloadableArtifact(artifactId);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('downloadable artifact inventory skips directory artifacts that fail to archive', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-artifacts-archive-error-'));
  const filePath = path.join(tempDir, 'report.json');
  const tracePath = path.join(tempDir, '--profile.trace');
  fs.writeFileSync(filePath, '{}\n');
  fs.mkdirSync(tracePath, { recursive: true });
  fs.writeFileSync(path.join(tracePath, 'metadata.json'), '{}\n');
  const artifactIds = [
    trackDownloadableArtifact({
      artifactPath: filePath,
      artifactType: 'test-report',
      fileName: 'report.json',
    }),
    trackDownloadableArtifact({
      artifactPath: tracePath,
      artifactType: 'trace-log',
      fileName: 'profile.trace',
    }),
  ];

  try {
    const artifacts = await withCommandExecutorOverride(
      (cmd) => {
        if (cmd !== 'tar') return undefined;
        throw new Error('tar unavailable');
      },
      async () => await listDownloadableArtifacts(),
    );
    assert.deepEqual(
      artifacts.map((artifact) => artifact.filename),
      ['report.json'],
    );
  } finally {
    for (const artifactId of artifactIds) {
      cleanupDownloadableArtifact(artifactId);
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('daemon artifact inventory exposes directory artifacts as tar.gz downloads', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-artifacts-directory-'));
  const tracePath = path.join(tempDir, '--profile.trace');
  fs.mkdirSync(tracePath, { recursive: true });
  fs.writeFileSync(path.join(tracePath, 'metadata.json'), '{"ok":true}\n');
  const artifactId = trackDownloadableArtifact({
    artifactPath: tracePath,
    artifactType: 'trace-log',
    fileName: 'profile.trace',
  });
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });

  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = { authorization: 'Bearer daemon-secret' };

    const inventory = await fetch(`${baseUrl}/artifacts`, { headers: auth });
    assert.equal(inventory.status, 200);
    const body = (await inventory.json()) as ArtifactInventoryResponse;
    const artifact = body.artifacts.find((entry) => entry.id === artifactId);
    assert.ok(artifact, `expected ${artifactId} in artifact inventory`);
    assert.equal(artifact.filename, 'profile.trace.tar.gz');
    assert.equal(artifact.mimeType, 'application/gzip');
    assert.ok(artifact.sizeBytes > 0);

    const consumingDownload = await fetch(
      `${baseUrl}/artifacts/${encodeURIComponent(artifactId)}?download=1`,
      {
        headers: auth,
      },
    );
    assert.equal(consumingDownload.status, 200);
    assert.equal(consumingDownload.headers.get('content-type'), 'application/gzip');
    assert.equal(consumingDownload.headers.get('content-length'), String(artifact.sizeBytes));
    assert.match(
      consumingDownload.headers.get('content-disposition') ?? '',
      /profile\.trace\.tar\.gz/,
    );
    const archivePath = path.join(tempDir, 'downloaded.tar.gz');
    fs.writeFileSync(archivePath, Buffer.from(await consumingDownload.arrayBuffer()));
    const entries = runCmdSync('tar', ['-tzf', archivePath]).stdout;
    assert.match(entries, /--profile\.trace\/metadata\.json/);

    await waitFor(() => !fs.existsSync(tracePath));
    assert.equal(fs.existsSync(tracePath), false);
    const inventoryAfterConsume = await fetch(`${baseUrl}/artifacts`, { headers: auth });
    const consumedBody = (await inventoryAfterConsume.json()) as ArtifactInventoryResponse;
    assert.equal(
      consumedBody.artifacts.some((entry) => entry.id === artifactId),
      false,
    );
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('daemon artifact inventory lists artifacts and downloads consume them', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-artifacts-http-'));
  const artifactPath = path.join(tempDir, 'shot.png');
  fs.writeFileSync(artifactPath, 'png-body');
  const artifactId = trackDownloadableArtifact({
    artifactPath,
    artifactType: 'screenshot',
    fileName: 'shot.png',
  });
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });

  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = { authorization: 'Bearer daemon-secret' };

    const inventory = await fetch(`${baseUrl}/artifacts`, { headers: auth });
    assert.equal(inventory.status, 200);
    const body = (await inventory.json()) as ArtifactInventoryResponse;
    const artifact = body.artifacts.find((entry) => entry.id === artifactId);
    assert.ok(artifact, `expected ${artifactId} in artifact inventory`);
    assert.equal(artifact.artifactType, 'screenshot');
    assert.equal(artifact.filename, 'shot.png');
    assert.equal(artifact.mimeType, 'application/octet-stream');
    assert.equal(artifact.sizeBytes, 'png-body'.length);
    assert.ok(Date.parse(artifact.createdAt));
    assert.ok(Date.parse(artifact.expiresAt));

    const consumingDownload = await fetch(
      `${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        headers: auth,
      },
    );
    assert.equal(consumingDownload.status, 200);
    assert.equal(await consumingDownload.text(), 'png-body');
    await waitFor(() => !fs.existsSync(artifactPath));

    const inventoryAfterConsume = await fetch(`${baseUrl}/artifacts`, { headers: auth });
    const consumedBody = (await inventoryAfterConsume.json()) as ArtifactInventoryResponse;
    assert.equal(
      consumedBody.artifacts.some((entry) => entry.id === artifactId),
      false,
    );
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('daemon artifact downloads can keep the source file while consuming the inventory entry', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-artifacts-retain-file-'));
  const artifactPath = path.join(tempDir, 'runner-output.txt');
  fs.writeFileSync(artifactPath, 'runner-output');
  const artifactId = trackDownloadableArtifact({
    artifactPath,
    artifactType: 'runner-output',
    fileName: 'runner-output.txt',
    deleteAfterDownload: false,
  });
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });

  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = { authorization: 'Bearer daemon-secret' };

    const inventory = await fetch(`${baseUrl}/artifacts`, { headers: auth });
    assert.equal(inventory.status, 200);
    const body = (await inventory.json()) as ArtifactInventoryResponse;
    assert.ok(body.artifacts.some((entry) => entry.id === artifactId));

    const consumingDownload = await fetch(
      `${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`,
      {
        headers: auth,
      },
    );
    assert.equal(consumingDownload.status, 200);
    assert.equal(await consumingDownload.text(), 'runner-output');
    assert.equal(fs.existsSync(artifactPath), true);

    await waitFor(async () => {
      const inventoryAfterConsume = await fetch(`${baseUrl}/artifacts`, { headers: auth });
      const consumedBody = (await inventoryAfterConsume.json()) as ArtifactInventoryResponse;
      return !consumedBody.artifacts.some((entry) => entry.id === artifactId);
    });
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('daemon artifact downloads can be forced retained by server option', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-artifacts-retain-all-'));
  const artifactPath = path.join(tempDir, 'session-log.txt');
  fs.writeFileSync(artifactPath, 'log-body');
  const artifactId = trackDownloadableArtifact({
    artifactPath,
    artifactType: 'session-log',
    fileName: 'session-log.txt',
  });
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    retainArtifacts: true,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });

  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const auth = { authorization: 'Bearer daemon-secret' };

    const bareDownload = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: auth,
    });
    assert.equal(bareDownload.status, 200);
    assert.equal(await bareDownload.text(), 'log-body');
    assert.equal(fs.existsSync(artifactPath), true);

    const secondDownload = await fetch(`${baseUrl}/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: auth,
    });
    assert.equal(secondDownload.status, 200);
    assert.equal(await secondDownload.text(), 'log-body');
    assert.equal(fs.existsSync(artifactPath), true);

    const inventoryAfterDownloads = await fetch(`${baseUrl}/artifacts`, { headers: auth });
    const body = (await inventoryAfterDownloads.json()) as ArtifactInventoryResponse;
    assert.ok(body.artifacts.some((entry) => entry.id === artifactId));
  } finally {
    cleanupDownloadableArtifact(artifactId);
    await closeLoopbackServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}
