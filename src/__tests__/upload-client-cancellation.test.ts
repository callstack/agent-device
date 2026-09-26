// Ending an artifact upload when the work it serves is over (#2946).
//
// A beat that finds the device's lease gone aborts the upload protecting that lease. An upload is a
// piped `node:http` request, so the only way to stop bytes already in flight is the request's own
// abort signal — a rejection the caller swallows would keep streaming a full app bundle to a device
// nobody owns. Kept out of `upload-client.test.ts`, which is already over the test-file size
// tripwire and may not grow (docs/agents/testing.md).

import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { uploadArtifact } from '../remote/upload-client.ts';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

const TEST_TOKEN = 'agent-device-upload-cancel-token';
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

test('an aborted signal ends a legacy upload mid-stream instead of finishing the bytes', async () => {
  // Two megabytes is well past what a paused read lets through: the assertions below are about the
  // stream stopping, and a smaller payload keeps that off the CPU in a loaded lane.
  const content = Buffer.alloc(2 * 1024 * 1024, 'x');
  const artifactPath = createTempFile('app.apk', content);
  const control = new AbortController();
  let sawBytes = 0;

  // Preflight reports itself unsupported so the upload takes the legacy stream, the one path that
  // pipes a file at the daemon and keeps going for as long as the daemon drains it.
  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      req.on('data', (chunk: Buffer) => {
        sawBytes += chunk.length;
        // The lease dies once bytes are genuinely in flight — not before the request starts.
        // Stopping the read applies backpressure so the rest of the file cannot race through
        // loopback and make "stopped early" a matter of timing.
        req.pause();
        if (!control.signal.aborted) control.abort();
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    await assert.rejects(
      async () =>
        await uploadArtifact({
          localPath: artifactPath,
          baseUrl: server.baseUrl,
          token: TEST_TOKEN,
          signal: control.signal,
        }),
    );
    assert.ok(sawBytes > 0, 'the upload had started streaming before the abort');
    assert.ok(sawBytes < content.length, `the stream stopped early, at ${sawBytes} bytes`);
  } finally {
    await server.close();
  }
});

test('an aborted signal before preflight refuses to ask the daemon for a ticket', async () => {
  const artifactPath = createTempFile('app.apk', 'payload');
  const control = new AbortController();
  control.abort();
  const requests: string[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    await assert.rejects(
      async () =>
        await uploadArtifact({
          localPath: artifactPath,
          baseUrl: server.baseUrl,
          token: TEST_TOKEN,
          signal: control.signal,
        }),
    );
    assert.deepEqual(requests, [], 'an upload nobody waits for never reaches the daemon');
  } finally {
    await server.close();
  }
});

test('an upload with no signal behaves exactly as before', async () => {
  const content = 'unprotected-payload';
  const artifactPath = createTempFile('app.apk', content);
  const expectedHash = createHash('sha256').update(content).digest('hex');

  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      assert.equal(req.headers['x-artifact-hash'], expectedHash);
      await readRequestBody(req);
      sendJson(res, { ok: true, uploadId: 'upload-uncancelled' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-uncancelled');
  } finally {
    await server.close();
  }
});

function createTempFile(filename: string, content: string | Buffer): string {
  const dir = mkdtempForTestSync('agent-device-upload-cancel-');
  tempDirs.push(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  // A canceled upload leaves its socket in a state `closeAllConnections` can race; without a bound
  // idle keep-alive, `close` would then wait out Node's five-second default.
  server.keepAliveTimeout = 100;
  server.listen(0, '127.0.0.1');
  server.unref();
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      // A canceled upload leaves its socket half-open and a pooled keep-alive one behind; without
      // dropping them, `close` would wait out the server's five-second keep-alive timeout.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
