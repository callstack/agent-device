import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

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
async function withIO<T>(pending: Promise<T>, label = 'loopback I/O'): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timeout = realSetTimeout(() => reject(new Error(`${label} did not complete in 3s`)), 3_000);
  });
  try {
    return await Promise.race([pending, guard]);
  } finally {
    realClearTimeout(timeout);
  }
}

function ioBarrier(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
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
    // A chunk answered after its body is read keeps the connection.
    assert.notEqual(first.headers.connection, 'close');

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
    assert.notEqual(second.headers.connection, 'close');

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
    assert.notEqual(preflight.headers.connection, 'close');
    assert.notEqual(finalized.headers.connection, 'close');
    const artifact = JSON.parse(finalized.body) as { ok: boolean; uploadId: string };
    assert.equal(artifact.ok, true);
    cleanupUploadedArtifact(artifact.uploadId);
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('both upload JSON routes accept a progressing body across the 120 s idle window', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const bytes = Buffer.from('ABCD');
  const auth = { authorization: 'Bearer daemon-secret' };
  const sendSlowJson = async (path: string, json: string) => {
    const firstRead = ioBarrier();
    const secondRead = ioBarrier();
    let client: http.ClientRequest | undefined;
    server.prependOnceListener('request', (req) => {
      const read = req.read.bind(req);
      let bodyBytes = 0;
      req.read = (size?: number) => {
        const chunk = read(size);
        if (Buffer.isBuffer(chunk)) {
          bodyBytes += chunk.length;
          if (bodyBytes >= 1) firstRead.resolve();
          if (bodyBytes >= 2) secondRead.resolve();
        }
        return chunk;
      };
    });
    const reply = routeRequest(
      port,
      {
        method: 'POST',
        path,
        headers: {
          ...auth,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(json),
        },
      },
      (req) => {
        client = req;
        req.write(json.slice(0, 1));
      },
    );
    void reply.catch(() => {});
    try {
      await withIO(firstRead.promise);
      assert.ok(client);
      await vi.advanceTimersByTimeAsync(90_000);
      client.write(json.slice(1, 2));
      await withIO(secondRead.promise);
      await vi.advanceTimersByTimeAsync(90_000);
      client.end(json.slice(2));
      return await withIO(reply);
    } finally {
      client?.destroy();
    }
  };

  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const preflight = await sendSlowJson('/upload/preflight', preflightBody(bytes));
    assert.equal(preflight.status, 200);
    const { uploadId } = JSON.parse(preflight.body) as { uploadId: string };
    const put = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...auth, 'content-range': 'bytes 0-3/4' },
        },
        (req) => req.end(bytes),
      ),
    );
    assert.equal(put.status, 200);

    const finalized = await sendSlowJson('/upload/finalize', JSON.stringify({ uploadId }));
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

test('stalled PUT rolls back at 120 s and finalize can spend longer on its hash', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const partialWritten = ioBarrier();
  const hashStarted = ioBarrier();
  const releaseHash = ioBarrier();
  const createWriteStream = fs.createWriteStream;
  const createReadStream = fs.createReadStream;
  let payloadPath: fs.PathLike | undefined;
  const writers = vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    if (typeof options !== 'object' || options.flags !== 'a') {
      return createWriteStream(path, options);
    }
    payloadPath = path;
    return createWriteStream(path, {
      ...options,
      fs: {
        open: fs.open,
        close: fs.close,
        write(fd, buffer, offset, length, position, callback) {
          fs.write(fd, buffer, offset, length, position, (error, written, data) => {
            callback(error, written, data);
            if (!error) partialWritten.resolve();
          });
        },
      },
    });
  });
  const readers = vi.spyOn(fs, 'createReadStream').mockImplementation((path, options) => {
    if (path !== payloadPath || typeof options !== 'object') {
      return createReadStream(path, options);
    }
    return createReadStream(path, {
      ...options,
      fs: {
        open: fs.open,
        close: fs.close,
        read(...args) {
          hashStarted.resolve();
          void releaseHash.promise.then(() => Reflect.apply(fs.read, fs, args));
        },
      },
    });
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const auth = { authorization: 'Bearer daemon-secret' };
    const json = { ...auth, 'content-type': 'application/json' };
    const bytes = Buffer.from('ABCD');
    const preflight = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/preflight', headers: json }, (req) =>
        req.end(preflightBody(bytes)),
      ),
    );
    assert.equal(preflight.status, 200);
    const { uploadId } = JSON.parse(preflight.body) as { uploadId: string };
    const put: http.RequestOptions = {
      method: 'PUT',
      path: `/upload/direct/${uploadId}`,
      headers: { ...auth, 'content-range': 'bytes 0-3/4' },
    };
    const socketClosed = ioBarrier();
    let stalledSettled = false;
    const closed = routeRequest(
      port,
      { ...put, headers: { ...put.headers, connection: 'close', 'content-length': 4 } },
      (req) => {
        req.once('socket', (socket) => socket.once('close', () => socketClosed.resolve()));
        req.write('AB');
      },
    )
      .then(
        ({ status, body }) => {
          assert.equal(status, 500);
          assert.equal(JSON.parse(body).reason, 'transfer_phase_timeout');
        },
        (error) => assert.equal(error.code, 'ECONNRESET'),
      )
      .finally(() => {
        stalledSettled = true;
      });
    void closed.catch(() => {});
    await withIO(partialWritten.promise);
    await vi.advanceTimersByTimeAsync(119_999);
    assert.equal(stalledSettled, false);
    await vi.advanceTimersByTimeAsync(1);
    await withIO(Promise.all([closed, socketClosed.promise]));

    const retry = await withIO(routeRequest(port, put, (req) => req.end(bytes)));
    assert.equal(retry.status, 200);
    assert.equal(retry.body, 'ok');

    const finalize = routeRequest(
      port,
      { method: 'POST', path: '/upload/finalize', headers: json },
      (req) => req.end(JSON.stringify({ uploadId })),
    );
    void finalize.catch(() => {});
    // Hold the real hash read after body completion, independent of disk speed.
    await withIO(hashStarted.promise);
    await vi.advanceTimersByTimeAsync(150_000);
    releaseHash.resolve();
    const finalized = await withIO(finalize);
    assert.equal(finalized.status, 200);
    const artifact = JSON.parse(finalized.body) as { ok: boolean; uploadId: string };
    assert.equal(artifact.ok, true);
    cleanupUploadedArtifact(artifact.uploadId);
  } finally {
    releaseHash.resolve();
    readers.mockRestore();
    writers.mockRestore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a finalize queued behind a held ticket answers at its own deadline', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const partialWritten = ioBarrier();
  const rollbackStarted = ioBarrier();
  const releaseRollback = ioBarrier();
  const createWriteStream = fs.createWriteStream;
  const writers = vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    const stream = createWriteStream(path, options);
    if (typeof options === 'object' && options.flags === 'a') {
      stream.once('ready', () => stream.once('drain', () => partialWritten.resolve()));
      const write = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: never[]) => {
        const accepted = write(chunk as never, ...rest);
        if (accepted) partialWritten.resolve();
        return accepted;
      }) as typeof stream.write;
    }
    return stream;
  });
  const truncate = fs.promises.truncate.bind(fs.promises);
  // The stalled chunk's rollback holds the ticket past the queued finalize's deadline.
  const rollbacks = vi.spyOn(fs.promises, 'truncate').mockImplementation(async (target, length) => {
    rollbackStarted.resolve();
    await releaseRollback.promise;
    await truncate(target, length);
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const auth = { authorization: 'Bearer daemon-secret' };
    const json = { ...auth, 'content-type': 'application/json' };
    const preflight = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/preflight', headers: json }, (req) =>
        req.end(preflightBody(Buffer.from('ABCD'))),
      ),
    );
    assert.equal(preflight.status, 200);
    const { uploadId } = JSON.parse(preflight.body) as { uploadId: string };

    const stalled = routeRequest(
      port,
      {
        method: 'PUT',
        path: `/upload/direct/${uploadId}`,
        headers: {
          ...auth,
          connection: 'close',
          'content-range': 'bytes 0-3/4',
          'content-length': 4,
        },
      },
      (req) => req.write('AB'),
    );
    void stalled.catch(() => {});
    await withIO(partialWritten.promise);

    const finalizeBodyRead = ioBarrier();
    server.prependOnceListener('request', (req: http.IncomingMessage) =>
      req.once('end', () => finalizeBodyRead.resolve()),
    );
    const finalize = routeRequest(
      port,
      { method: 'POST', path: '/upload/finalize', headers: json },
      (req) => req.end(JSON.stringify({ uploadId })),
    );
    void finalize.catch(() => {});
    await withIO(finalizeBodyRead.promise);
    await flushIO();

    // The chunk stalls at 120 s and its rollback keeps the ticket held.
    await vi.advanceTimersByTimeAsync(120_000);
    await withIO(rollbackStarted.promise);
    // The finalize's own 600 s deadline releases it from the queue.
    await vi.advanceTimersByTimeAsync(480_000);
    const answered = await withIO(finalize, 'the queued finalize answer');
    assert.equal(answered.status, 500);
    assert.equal(JSON.parse(answered.body).reason, 'transfer_ingress_deadline_exceeded');
  } finally {
    releaseRollback.resolve();
    rollbacks.mockRestore();
    writers.mockRestore();
    vi.useRealTimers();
    await flushIO();
    await closeLoopbackServer(server);
  }
});

test('an early answer to an unfinished body closes the connection and keeps the 308 offset', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const agent = new http.Agent({ keepAlive: true });
  const sendUnfinished = async (options: http.RequestOptions) => {
    const socketClosed = ioBarrier();
    const reply = routeRequest(port, { ...options, agent }, (req) => {
      req.once('socket', (socket) => socket.once('close', () => socketClosed.resolve()));
      req.write('A');
    });
    const answered = await withIO(reply, 'the early answer');
    // The server closes the connection instead of draining the unread body.
    await withIO(socketClosed.promise, 'the server close of the early-answered connection');
    return answered;
  };
  try {
    const auth = { authorization: 'Bearer daemon-secret' };
    const json = { ...auth, 'content-type': 'application/json' };
    const preflight = await withIO(
      routeRequest(port, { method: 'POST', path: '/upload/preflight', headers: json }, (req) =>
        req.end(preflightBody(Buffer.from('ABCD'))),
      ),
    );
    assert.equal(preflight.status, 200);
    const { uploadId } = JSON.parse(preflight.body) as { uploadId: string };
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

    // An offset mismatch answers 308 before its body arrives.
    const mismatch = await sendUnfinished({
      method: 'PUT',
      path: `/upload/direct/${uploadId}`,
      headers: { ...auth, 'content-range': 'bytes 0-1/4', 'content-length': '2' },
    });
    assert.equal(mismatch.status, 308);
    assert.equal(mismatch.headers.range, 'bytes=0-1');
    assert.equal(mismatch.headers['x-upload-offset'], '2');
    assert.equal(mismatch.headers.connection, 'close');

    // An authorization refusal answers before its body arrives.
    const refused = await sendUnfinished({
      method: 'PUT',
      path: `/upload/direct/${uploadId}`,
      headers: { 'content-range': 'bytes 2-3/4', 'content-length': '2' },
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.connection, 'close');
  } finally {
    agent.destroy();
    await closeLoopbackServer(server);
  }
});
