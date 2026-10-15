import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { downloadRemoteArtifactFromUrl } from '../artifact-download.ts';
import { DAEMON_HTTP_LEASE_HEADER } from '@agent-device/contracts/daemon-http';

type DownloadParams = Parameters<typeof downloadRemoteArtifactFromUrl>[0];

function downloadTo(
  tempRoot: string,
  port: number,
  overrides: Partial<DownloadParams> = {},
): Promise<string> {
  return downloadRemoteArtifactFromUrl({
    artifactUrl: new URL(`http://127.0.0.1:${port}/agent-device/artifacts/artifact`),
    token: 'remote-secret',
    artifactId: 'artifact',
    destinationPath: path.join(tempRoot, 'artifacts', 'screen.png'),
    requestScope: { requestId: 'req-artifact-download' },
    ...overrides,
  });
}

async function closedLoopbackPort(): Promise<number> {
  const server = net.createServer();
  const port = await listenOnLoopback(server);
  await closeLoopbackServer(server);
  return port;
}

test('downloadRemoteArtifactFromUrl reports HTTP error responses with status and body', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact download error-response coverage')) return;
  const tempRoot = mkdtempForTestSync('agent-device-artifact-http-error-');
  const destinationPath = path.join(tempRoot, 'artifacts', 'screen.png');
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end('artifact expired');
  });
  const port = await listenOnLoopback(server);

  try {
    await assert.rejects(
      () => downloadTo(tempRoot, port),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.message === 'Failed to download remote artifact',
          true,
        );
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.statusCode, 404);
        assert.equal(details?.body, 'artifact expired');
        assert.equal(details?.artifactId, 'artifact');
        assert.equal(details?.requestId, 'req-artifact-download');
        return true;
      },
    );
    assert.equal(fs.existsSync(destinationPath), false);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('downloadRemoteArtifactFromUrl wraps transport errors raised before the response starts', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact download transport-error coverage')) return;
  const tempRoot = mkdtempForTestSync('agent-device-artifact-transport-error-');
  const port = await closedLoopbackPort();

  try {
    await assert.rejects(
      () => downloadTo(tempRoot, port),
      (error: unknown) => {
        assert.equal(
          error instanceof Error && error.message === 'Failed to download remote artifact',
          true,
        );
        const wrapped = (error as { cause?: Error }).cause;
        assert.equal(wrapped instanceof Error, true);
        assert.equal((wrapped as NodeJS.ErrnoException | undefined)?.code, 'ECONNREFUSED');
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(tempRoot, 'artifacts', 'screen.png')), false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('downloadRemoteArtifactFromUrl times out before response headers arrive without materializing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact download pre-response timeout coverage'))
    return;
  const tempRoot = mkdtempForTestSync('agent-device-artifact-header-timeout-');
  const server = http.createServer(() => {
    // Accept the request and never answer, so the timeout fires before materialization starts.
  });
  const port = await listenOnLoopback(server);

  try {
    await assert.rejects(
      () => downloadTo(tempRoot, port, { timeoutMs: 50 }),
      (error: unknown) => {
        assert.match(String((error as Error).message), /timed out/i);
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.timeoutMs, 50);
        assert.equal(details?.artifactId, 'artifact');
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(tempRoot, 'artifacts', 'screen.png')), false);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('downloadRemoteArtifactFromUrl removes directory staging when a 2xx body fails extraction', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact download directory-staging coverage')) return;
  const tempRoot = mkdtempForTestSync('agent-device-artifact-directory-staging-');
  const artifactsRoot = path.join(tempRoot, 'remote-device-artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactsRoot, 'previous-run-marker.txt'), 'keep me');
  // A 200 with a body that is not a gzip archive: materialization starts, staging is created,
  // and extraction fails inside it — the path where the hidden staging directory really exists
  // and must be removed while the caller-owned root stays untouched.
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/gzip');
    res.end('this is not a gzip archive');
  });
  const port = await listenOnLoopback(server);

  try {
    await assert.rejects(
      () =>
        downloadTo(tempRoot, port, {
          destinationPath: artifactsRoot,
          isDirectory: true,
        }),
      (error: unknown) => {
        assert.equal(error instanceof Error, true);
        // The extraction failure surfaces as-is (not the HTTP-error AppError): the status was
        // already 2xx, so the only defensible description left is the materializer's own error.
        assert.doesNotMatch(String((error as Error).message), /Failed to download remote artifact/);
        return true;
      },
    );
    assert.equal(
      fs.readFileSync(path.join(artifactsRoot, 'previous-run-marker.txt'), 'utf8'),
      'keep me',
    );
    assert.deepEqual(
      fs.readdirSync(artifactsRoot),
      ['previous-run-marker.txt'],
      'failed extraction must remove the hidden staging directory it created',
    );
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('downloadRemoteArtifactFromUrl names the held lease and sends no lease header without one', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact download lease header coverage')) return;
  const tempRoot = mkdtempForTestSync('agent-device-artifact-lease-header-');
  const leaseHeaders: unknown[] = [];
  const server = http.createServer((req, res) => {
    leaseHeaders.push(req.headers[DAEMON_HTTP_LEASE_HEADER]);
    res.statusCode = 200;
    res.end('png-bytes');
  });
  const port = await listenOnLoopback(server);

  try {
    await downloadTo(tempRoot, port, {
      requestScope: { requestId: 'req-leased', leaseId: 'lease-1' },
    });
    await downloadTo(tempRoot, port, {
      requestScope: { requestId: 'req-unleased' },
    });
    assert.deepEqual(leaseHeaders, ['lease-1', undefined]);
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
