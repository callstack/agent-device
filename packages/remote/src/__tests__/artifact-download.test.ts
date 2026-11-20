import { test, vi } from 'vitest';
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
import { downloadRemoteArtifactFromUrl, fetchRemoteArtifactFromUrl } from '../artifact-download.ts';
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

test('rejects redirect bodies and interrupted error bodies, and downloads success', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact response coverage')) return;
  const tempRoot = mkdtempForTestSync('artifact-responses-');
  let response = 0;
  const server = http.createServer((_req, res) => {
    response++;
    if (response === 1) {
      res.writeHead(302, { location: '/elsewhere' });
      res.end('redirect body');
    } else if (response === 2) {
      res.writeHead(500, { 'content-length': '100' });
      res.write('partial');
      setTimeout(() => res.socket?.destroy(), 10);
    } else {
      res.end('artifact bytes');
    }
  });
  const port = await listenOnLoopback(server);
  const destination = path.join(tempRoot, 'artifacts', 'screen.png');
  try {
    for (const status of [302, 500]) {
      await assert.rejects(
        () => downloadTo(tempRoot, port, { timeoutMs: 1000 }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
          assert.equal(
            (error as { details?: { statusCode?: number } }).details?.statusCode,
            status,
          );
          return true;
        },
      );
      assert.equal(fs.existsSync(destination), false);
    }
    await downloadTo(tempRoot, port);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'artifact bytes');
  } finally {
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function fetchFrom(port: number, maxBytes: number): Promise<Buffer> {
  return fetchRemoteArtifactFromUrl({
    artifactUrl: new URL(`http://127.0.0.1:${port}/agent-device/artifacts/artifact`),
    token: 'remote-secret',
    artifactId: 'artifact',
    requestScope: { requestId: 'req-artifact-fetch' },
    maxBytes,
  });
}

test('an in-memory fetch stops a body that crosses its cap and releases the response', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact fetch cap')) return;
  let released: () => void = () => {};
  const responseReleased = new Promise<void>((resolve) => {
    released = resolve;
  });
  // No Content-Length, and no end: only the cap applied to arriving bytes stops this body.
  const server = http.createServer((_req, res) => {
    res.on('close', released);
    res.writeHead(200);
    const write = () => {
      if (!res.destroyed) res.write('x'.repeat(1024), () => setTimeout(write, 5));
    };
    write();
  });
  const port = await listenOnLoopback(server);

  try {
    await assert.rejects(
      () => fetchFrom(port, 4096),
      (error: unknown) =>
        (error as { details?: Record<string, unknown> }).details?.reason === 'artifact_too_large',
    );
    await responseReleased;
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an in-memory fetch returns a body of exactly its cap and refuses one byte more', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact fetch cap boundary')) return;
  const server = http.createServer((_req, res) => res.end('x'.repeat(1024)));
  const port = await listenOnLoopback(server);

  try {
    assert.equal((await fetchFrom(port, 1024)).toString(), 'x'.repeat(1024));
    await assert.rejects(() => fetchFrom(port, 1023));
  } finally {
    await closeLoopbackServer(server);
  }
});

test('an in-memory fetch returns a body that arrives in very small chunks unchanged', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact fetch small chunks')) return;
  // Past the first allocation, so the buffer grows more than once, and no two neighbouring bytes repeat.
  const body = Buffer.from(Array.from({ length: 300_000 }, (_, index) => (index * 31) % 251));
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.socket?.setNoDelay(true);
    let sent = 0;
    const write = () => {
      for (let burst = 0; burst < 2_000 && sent < body.length; burst += 1, sent += 3) {
        res.write(body.subarray(sent, sent + 3));
      }
      if (sent < body.length) setImmediate(write);
      else res.end();
    };
    write();
  });
  const port = await listenOnLoopback(server);

  try {
    const fetched = await fetchFrom(port, body.length);
    assert.equal(fetched.length, body.length);
    assert.equal(fetched.equals(body), true);
  } finally {
    await closeLoopbackServer(server);
  }
});

for (const route of ['in-memory fetch', 'file download', 'directory download'] as const) {
  test(`an error answer to the ${route} is dropped once its diagnostic is full`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t, 'artifact error body cap')) return;
    const tempRoot = mkdtempForTestSync('agent-device-artifact-error-cap-');
    let released: () => void = () => {};
    const responseReleased = new Promise<void>((resolve) => {
      released = resolve;
    });
    // A 500 whose body never ends: only the client dropping the response finishes this request.
    const server = http.createServer((_req, res) => {
      res.on('close', released);
      res.writeHead(500);
      const write = () => {
        if (!res.destroyed) res.write('x'.repeat(16 * 1024), () => setImmediate(write));
      };
      write();
    });
    const port = await listenOnLoopback(server);
    const attempt = {
      'in-memory fetch': () => fetchFrom(port, 1024),
      'file download': () => downloadTo(tempRoot, port),
      'directory download': () =>
        downloadTo(tempRoot, port, { destinationPath: tempRoot, isDirectory: true }),
    }[route];

    try {
      await assert.rejects(attempt, (error: unknown) => {
        assert.equal((error as Error).message, 'Failed to download remote artifact');
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.statusCode, 500);
        assert.equal(details?.artifactId, 'artifact');
        assert.equal(details?.body, 'x'.repeat(65_536));
        return true;
      });
      await responseReleased;
      // The file route makes its parent directory before it asks; no route leaves a file behind.
      const left = fs.readdirSync(tempRoot, { recursive: true });
      assert.deepEqual(left, route === 'file download' ? ['artifacts'] : []);
    } finally {
      await closeLoopbackServer(server);
    }
  });
}

test('a cleanup that fails after a failed download keeps the download error and raises no unhandled rejection', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'artifact download cleanup-failure coverage')) return;
  const tempRoot = mkdtempForTestSync('agent-device-artifact-cleanup-failure-');
  const server = http.createServer((_req, res) => {
    res.statusCode = 404;
    res.end('artifact expired');
  });
  const port = await listenOnLoopback(server);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const rm = vi
    .spyOn(fs.promises, 'rm')
    .mockRejectedValueOnce(
      Object.assign(new Error('The share connection dropped'), { code: 'ECONNRESET' }),
    );

  try {
    await assert.rejects(
      () => downloadTo(tempRoot, port),
      (error: unknown) => {
        assert.equal((error as { details?: { statusCode?: number } }).details?.statusCode, 404);
        return true;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rm.mock.calls.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    rm.mockRestore();
    process.off('unhandledRejection', onUnhandled);
    await closeLoopbackServer(server);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
