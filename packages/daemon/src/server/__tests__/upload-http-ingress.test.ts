import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { createDaemonHttpServer } from '../http/http-server.ts';
import { cleanupUploadedArtifact } from '../../resources/artifact-tracking.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

type RouteResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/** A loopback request over the real route, using the node:http client so fake timers cannot stall it. */
function routeRequest(
  port: number,
  options: http.RequestOptions,
  write?: (req: http.ClientRequest) => void,
): Promise<RouteResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    if (write) write(req);
    else req.end();
  });
}

/** Bounds a promise against a real-I/O stall while the clock is faked. */
async function withIO<T>(pending: Promise<T>): Promise<T> {
  const guard = (async () => {
    for (let i = 0; i < 1000; i += 1) await new Promise((r) => setImmediate(r));
    throw new Error('loopback I/O stalled under fake timers');
  })();
  void guard.catch(() => {});
  return await Promise.race([pending, guard]);
}

async function flushIO(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
}

function preflightBody(bytes: Buffer): string {
  return JSON.stringify({
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    uploadAttemptId: crypto.randomUUID(),
    fileName: 'artifact.bin',
    sizeBytes: bytes.length,
    artifactType: 'file',
  });
}

async function startServer(): Promise<{ server: http.Server; port: number }> {
  const server = await createDaemonHttpServer({
    token: 'daemon-secret',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env: process.env,
    cwd: process.cwd(),
  });
  const port = await listenOnLoopback(server);
  return { server, port };
}

test('upload route progress renews the ticket idle lifetime and keeps 308 framing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    // Controlled timers are installed before the ticket is created.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const auth = { authorization: 'Bearer daemon-secret' };
    const bytes = Buffer.from('ABCD');
    const body = preflightBody(bytes);
    const json = { ...auth, 'content-type': 'application/json' };

    const preflight = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/preflight', headers: json }, (req) =>
        req.end(body),
      ),
    );
    assert.equal(preflight.status, 200);
    const uploadId = (JSON.parse(preflight.body) as { uploadId: string }).uploadId;

    const first = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...auth, 'content-range': 'bytes 0-1/4', 'content-length': '2' },
        },
        (req) => req.end('AB'),
      ),
    );
    assert.equal(first.status, 308);
    assert.equal(first.headers.range, 'bytes=0-1');
    assert.equal(first.headers['x-upload-offset'], '2');

    // Four idle minutes pass, then accepted bytes renew the ticket's idle lifetime.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    const second = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...auth, 'content-range': 'bytes 2-3/4', 'content-length': '2' },
        },
        (req) => req.end('CD'),
      ),
    );
    assert.equal(second.status, 200);
    assert.equal(second.body, 'ok');

    // Eight minutes after ticket creation but under five since accepted progress, the
    // idempotent preflight still resolves to the same live ticket.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    const again = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/preflight', headers: json }, (req) =>
        req.end(body),
      ),
    );
    assert.equal(again.status, 200);
    assert.equal((JSON.parse(again.body) as { uploadId: string }).uploadId, uploadId);

    const finalized = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/finalize', headers: json }, (req) =>
        req.end(JSON.stringify({ uploadId })),
      ),
    );
    assert.equal(finalized.status, 200);
    const artifact = JSON.parse(finalized.body) as { ok: boolean; uploadId: string };
    assert.equal(artifact.ok, true);
    cleanupUploadedArtifact(artifact.uploadId);
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('client cancellation mid-chunk aborts the receive, rolls back, and the ticket expires on schedule', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const auth = { authorization: 'Bearer daemon-secret' };
    const bytes = Buffer.from('ABCD');
    const json = { ...auth, 'content-type': 'application/json' };

    const preflight = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/preflight', headers: json }, (req) =>
        req.end(preflightBody(bytes)),
      ),
    );
    assert.equal(preflight.status, 200);
    const uploadId = (JSON.parse(preflight.body) as { uploadId: string }).uploadId;

    // Cancel the chunk request mid-body: the route's ingress owner aborts the receive.
    const cancelled = withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...auth, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        (req) => {
          req.write('AB');
          req.destroy(new Error('client canceled'));
        },
      ),
    );
    await assert.rejects(cancelled, /client canceled/);
    await flushIO();

    // A full retry completes, proving the canceled chunk rolled back to offset zero.
    const retry = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...auth, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        (req) => req.end('ABCD'),
      ),
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body, 'ok');

    // After the idle lifetime with no further progress, the ticket is gone: cleanup ran.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    const finalized = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/finalize', headers: json }, (req) =>
        req.end(JSON.stringify({ uploadId })),
      ),
    );
    assert.equal(finalized.status, 404);
    assert.match(finalized.body, /not found or expired/i);
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});
