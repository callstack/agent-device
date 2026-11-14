// Ending an artifact upload when the work it serves is over (#2946).
//
// A beat that finds the device's lease gone aborts the upload protecting that lease. An upload is a
// piped `node:http` request, so the only way to stop bytes already in flight is the request's own
// abort signal — a rejection the caller swallows would keep streaming a full app bundle to a device
// nobody owns.

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AppError } from '@agent-device/kernel/errors';
import { once } from 'node:events';
import { uploadArtifact } from '../upload-client.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { observeOutcome } from './support/upload-transfer-fixtures.ts';

const TEST_TOKEN = 'agent-device-upload-cancel-token';
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const dir of tempDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

test('cancellation refuses preparation before it reads a missing artifact', async () => {
  const artifactPath = createTempFile('missing.apk', 'payload');
  fs.unlinkSync(artifactPath);
  const control = new AbortController();
  const reason = new Error('request owner stopped');
  control.abort(reason);
  const fetch = vi.spyOn(globalThis, 'fetch');
  await assert.rejects(
    uploadArtifact({
      env: process.env,
      localPath: artifactPath,
      baseUrl: 'http://127.0.0.1:1',
      token: TEST_TOKEN,
      signal: control.signal,
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(fetch.mock.calls.length, 0);
});

test('a standalone upload expires its preparation aggregate during hashing without starting a request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const artifactPath = createTempFile('app.apk', 'payload');
  const hashSource = new PassThrough();
  vi.spyOn(fs, 'createReadStream').mockReturnValue(hashSource as unknown as fs.ReadStream);
  const fetch = vi.spyOn(globalThis, 'fetch');
  const outcome = uploadArtifact({
    env: process.env,
    localPath: artifactPath,
    baseUrl: 'http://127.0.0.1:1',
    token: TEST_TOKEN,
  }).catch((error: unknown) => error);
  try {
    await vi.advanceTimersByTimeAsync(600_001);
    const error = await outcome;
    assert.ok(error instanceof AppError);
    assert.deepEqual(error.details, {
      reason: 'artifact_preparation_deadline_exceeded',
      transferPhase: 'preparation',
      timeoutMs: 600_000,
    });
    assert.equal(hashSource.destroyed, true);
    assert.equal(fetch.mock.calls.length, 0);
  } finally {
    hashSource.destroy();
    await outcome;
  }
});

test.each([
  'preflight',
  'finalize',
  'retry-preflight',
  'retry-finalize',
  'cancel-preflight',
  'cancel-finalize',
  'prose-preflight',
  'prose-finalize',
])('control request %s distinguishes a deadline from matching error prose', async (stage) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const caller = new AbortController();
  const artifactPath = createTempFile('app.apk', 'control-plane-payload');
  const retry = stage.startsWith('retry-');
  const prose = stage.startsWith('prose-');
  const canceled = stage.startsWith('cancel-');
  const callerReason = new Error('lease ended during control request');
  const phase = stage.endsWith('preflight') ? 'preflight' : 'finalize';
  const events: string[] = [];
  const routes: string[] = [];
  let uploads = 0;
  const server = await startServer(async (req, res) => {
    routes.push(`${req.method} ${req.url}`);
    if (retry && ++uploads === 1) {
      req.destroy();
      return;
    }
    await readRequestBody(req);
    sendJson(res, { ok: true, uploadId: 'control-upload' });
  });
  let entered = () => {};
  const stalled = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let stalledSignal: AbortSignal | undefined;
  let preflights = 0;
  let refuseStall: ((error: Error) => void) | undefined;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const route = new URL(String(input)).pathname;
    if (route.endsWith('/preflight')) preflights += 1;
    if (route.endsWith('/' + phase) && (!retry || preflights === 2)) {
      const signal = init?.signal;
      assert.ok(signal);
      stalledSignal = signal;
      entered();
      if (prose) throw new Error(`Artifact transfer ${phase} timed out`);
      return await new Promise<Response>((_resolve, reject) => {
        refuseStall = reject;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return Response.json({
      ok: true,
      uploadId: 'control-upload',
      upload: { url: `${server.baseUrl}/ticket`, headers: {} },
    });
  });
  const outcome = observeOutcome(
    uploadArtifact({
      env: process.env,
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
      signal: caller.signal,
      onProgress: (event) => events.push(event.type),
    }),
  );
  try {
    await stalled;
    if (prose) {
      const result = await outcome;
      assert.equal(result.error, undefined);
      assert.equal(result.value, 'control-upload');
      assert.ok(routes.includes('POST /upload'));
      assert.equal(stalledSignal?.aborted, false);
      return;
    }
    await vi.advanceTimersByTimeAsync(canceled ? 10_000 : 29_999);
    assert.equal(stalledSignal?.aborted, false);
    assert.equal(outcome.settled, false);
    if (canceled) caller.abort(callerReason);
    await vi.advanceTimersByTimeAsync(canceled ? 0 : 1);
    assert.equal(stalledSignal?.aborted, true);
    assert.equal(outcome.settled, true, 'expiry settles without starting another transfer');
    const result = await outcome;
    assert.equal(result.value, undefined);
    if (canceled) assert.equal(result.error, callerReason);
    else {
      assert.ok(result.error instanceof AppError);
      assert.deepEqual(result.error.details, {
        reason: 'transfer_phase_timeout',
        transferPhase: phase,
        timeoutMs: 30_000,
      });
    }
    assert.equal(caller.signal.aborted, canceled);
    assert.equal(events.includes('fallback'), false);
    const expectedTicketLegs = Number(retry) + Number(phase === 'finalize');
    assert.deepEqual(
      routes,
      Array.from({ length: expectedTicketLegs }, () => 'PUT /ticket'),
    );
    assert.equal(fetch.mock.calls.length, 1 + expectedTicketLegs);
  } finally {
    caller.abort(new Error('fixture cleanup'));
    refuseStall?.(new Error('fixture cleanup'));
    await outcome;
    await server.close();
  }
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
          env: process.env,
          localPath: artifactPath,
          baseUrl: server.baseUrl,
          token: TEST_TOKEN,
          signal: control.signal,
        }),
      isAbortError,
    );
    assert.ok(sawBytes > 0, 'the upload had started streaming before the abort');
    assert.ok(sawBytes < content.length, `the stream stopped early, at ${sawBytes} bytes`);
  } finally {
    await server.close();
  }
});

test('a cancel during the retried direct upload ends the upload without announcing a fallback', async () => {
  const artifactPath = createTempFile('app.apk', 'retried-direct-payload');
  const control = new AbortController();
  const reason = new Error('request owner stopped');
  const requests: string[] = [];
  const events: string[] = [];
  let ticketLegs = 0;
  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/upload/preflight') {
      await readRequestBody(req);
      sendJson(res, {
        ok: true,
        uploadId: 'retried-ticket',
        upload: { url: `${server.baseUrl}/ticket`, headers: {} },
      });
      return;
    }
    if (req.url === '/ticket') {
      ticketLegs += 1;
      // Leg one breaks as a retryable transport failure; the caller cancels during leg two.
      if (ticketLegs === 1) req.destroy();
      else control.abort(reason);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    await assert.rejects(
      uploadArtifact({
        env: process.env,
        localPath: artifactPath,
        baseUrl: server.baseUrl,
        token: TEST_TOKEN,
        signal: control.signal,
        onProgress: (event) => events.push(event.type),
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(events.includes('fallback'), false, events.join(','));
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'PUT /ticket',
      'POST /upload/preflight',
      'PUT /ticket',
    ]);
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
          env: process.env,
          localPath: artifactPath,
          baseUrl: server.baseUrl,
          token: TEST_TOKEN,
          signal: control.signal,
        }),
      isAbortError,
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
      env: process.env,
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-uncancelled');
  } finally {
    await server.close();
  }
});

function isAbortError(error: unknown): boolean {
  // The contract on `signal` is that an aborted upload rejects with the signal's own reason. Any
  // other rejection — a transport failure, the server-error fallback — means the upload stopped for
  // a reason this test is not about and would let the abort path regress while staying green.
  return error instanceof DOMException && error.name === 'AbortError';
}

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
