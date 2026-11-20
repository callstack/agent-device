import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { createDaemonHttpServer } from '../http/http-server.ts';
import { cleanupUploadedArtifact } from '../../resources/artifact-tracking.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
const TOKEN = 'daemon-secret';
const AUTH = { authorization: `Bearer ${TOKEN}` };
const JSON_HEADERS = { ...AUTH, 'content-type': 'application/json' };

type RouteResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

async function withIO<T>(pending: Promise<T>, label: string): Promise<T> {
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

function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushIO(): Promise<void> {
  for (let i = 0; i < 100; i += 1) await new Promise((r) => setImmediate(r));
}

/** Settles on the socket data that completes the text, however long the server's real IO takes. */
function receivedText(socket: net.Socket, isComplete: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = () => {
      if (!isComplete()) return;
      socket.off('data', check);
      resolve();
    };
    socket.on('data', check);
    check();
  });
}

function routeRequest(port: number, options: http.RequestOptions, body?: string | Buffer) {
  return new Promise<RouteResponse>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, agent: false, ...options }, (res) => {
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
    req.end(body);
  });
}

async function startServer() {
  const server = await createDaemonHttpServer({
    token: TOKEN,
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env: process.env,
    cwd: process.cwd(),
  });
  return { server, port: await listenOnLoopback(server) };
}

async function preflight(port: number, bytes: Buffer, sizeBytes = bytes.length): Promise<string> {
  const response = await routeRequest(
    port,
    { method: 'POST', path: '/upload/preflight', headers: JSON_HEADERS },
    JSON.stringify({
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      uploadAttemptId: crypto.randomUUID(),
      fileName: 'artifact.bin',
      sizeBytes,
      artifactType: 'file',
    }),
  );
  assert.equal(response.status, 200);
  return (JSON.parse(response.body) as { uploadId: string }).uploadId;
}

/** Holds every read of one payload file (the finalize hash) until released. */
function holdPayloadReads(isPayload: (path: fs.PathLike) => boolean) {
  const started = barrier();
  const release = barrier();
  const createReadStream = fs.createReadStream;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation((path, options) => {
    if (!isPayload(path) || typeof options !== 'object') return createReadStream(path, options);
    return createReadStream(path, {
      ...options,
      fs: {
        open: fs.open,
        close: fs.close,
        read(...args) {
          started.resolve();
          void release.promise.then(() => Reflect.apply(fs.read, fs, args));
        },
      },
    });
  });
  return { started, release, restore: () => spy.mockRestore() };
}

test('a timeout ends the exchange with a typed answer while a chunk write is still pending', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const writeStarted = barrier();
  const releaseWrite = barrier();
  const createWriteStream = fs.createWriteStream;
  const writers = vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    if (typeof options !== 'object' || options.flags !== 'a')
      return createWriteStream(path, options);
    return createWriteStream(path, {
      ...options,
      fs: {
        open: fs.open,
        close: fs.close,
        write(...args) {
          // The body reached EOF; its file write callback is held.
          writeStarted.resolve();
          void releaseWrite.promise.then(() => Reflect.apply(fs.write, fs, args));
        },
      },
    });
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bytes = Buffer.from('ABCD');
    const uploadId = await withIO(preflight(port, bytes), 'the preflight');
    const put = routeRequest(
      port,
      {
        method: 'PUT',
        path: `/upload/direct/${uploadId}`,
        headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
      },
      bytes,
    );
    void put.catch(() => {});
    await withIO(writeStarted.promise, 'the held chunk write');
    await vi.advanceTimersByTimeAsync(120_000);
    const answered = await withIO(put, 'the typed timeout answer');
    assert.equal(answered.status, 500);
    assert.equal(JSON.parse(answered.body).reason, 'transfer_phase_timeout');
    // The handler still owns the write: once it settles, the chunk rolls back.
    releaseWrite.resolve();
    await flushIO();
    vi.useRealTimers();
    const retry = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        bytes,
      ),
      'the retry',
    );
    assert.equal(retry.status, 200);
  } finally {
    releaseWrite.resolve();
    writers.mockRestore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a finalize whose hash crosses the deadline never publishes success', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const bytes = Buffer.from('ABCD');
  const reads = holdPayloadReads((path) => String(path).endsWith('/payload'));
  const realNow = performance.now.bind(performance);
  let skewMs = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + skewMs);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const uploadId = await withIO(preflight(port, bytes), 'the preflight');
    const put = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        bytes,
      ),
      'the chunk',
    );
    assert.equal(put.status, 200);
    const finalize = routeRequest(
      port,
      { method: 'POST', path: '/upload/finalize', headers: JSON_HEADERS },
      JSON.stringify({ uploadId }),
    );
    void finalize.catch(() => {});
    await withIO(reads.started.promise, 'the held hash read');
    // The monotonic clock crosses the 600 s aggregate inside the held read, before the
    // aggregate timer callback has a chance to run.
    skewMs = 600_001;
    reads.release.resolve();
    const answered = await withIO(finalize, 'the finalize answer');
    if (answered.status === 200) cleanupUploadedArtifact(JSON.parse(answered.body).uploadId);
    assert.equal(answered.status, 500);
    assert.equal(JSON.parse(answered.body).reason, 'transfer_ingress_deadline_exceeded');
  } finally {
    reads.release.resolve();
    reads.restore();
    clock.mockRestore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a queued 308 behind a long finalize never closes the socket under the earlier answer', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const reads = holdPayloadReads((path) => String(path).endsWith('/payload'));
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bytesA = Buffer.from('ABCD');
    const uploadA = await withIO(preflight(port, bytesA), 'preflight A');
    const putA = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadA}`,
          headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        bytesA,
      ),
      'chunk A',
    );
    assert.equal(putA.status, 200);
    const sizeB = 64 * 1024 * 1024;
    const uploadB = await withIO(preflight(port, Buffer.alloc(0), sizeB), 'preflight B');
    const seedB = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadB}`,
          headers: { ...AUTH, 'content-range': `bytes 0-0/${sizeB}`, 'content-length': '1' },
        },
        'a',
      ),
      'seed B',
    );
    assert.equal(seedB.headers['x-upload-offset'], '1');

    // One keep-alive socket: a complete finalize for A, then a stale-offset PUT for B whose
    // body stays unfinished. B's 308 queues behind A's long hash.
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('data', (data: Buffer) => {
      received += data.toString('latin1');
    });
    socket.on('error', () => {});
    const finalizeBody = JSON.stringify({ uploadId: uploadA });
    socket.write(
      `POST /upload/finalize HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(finalizeBody)}\r\n\r\n${finalizeBody}` +
        `PUT /upload/direct/${uploadB} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `Transfer-Encoding: chunked\r\n\r\n1\r\na\r\n`,
    );
    await withIO(reads.started.promise, 'the held finalize hash');
    await flushIO();
    // B's inactivity ceiling passes while A's in-budget hash still owns the socket.
    await vi.advanceTimersByTimeAsync(150_000);
    await flushIO();
    assert.equal(socket.destroyed, false, 'the socket survives B timing out behind A');
    reads.release.resolve();
    await withIO(closed, 'the socket close after both answers');
    const statuses = [...received.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => match[1]);
    assert.equal(statuses[0], '200', 'A finalizes with its own answer');
    assert.equal(statuses[1], '308', "B's queued answer follows");
    const artifact = received.match(/"uploadId":"([^"]+)"/)?.[1];
    if (artifact) cleanupUploadedArtifact(artifact);
  } finally {
    reads.release.resolve();
    reads.restore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

/** A monotonic clock the test can push past a deadline without running any timer callback. */
function skewableClock() {
  const realNow = performance.now.bind(performance);
  const clock = { skewMs: 0, restore: () => spy.mockRestore() };
  const spy = vi.spyOn(performance, 'now').mockImplementation(() => realNow() + clock.skewMs);
  return clock;
}

test('a preflight whose ticket creation crosses the deadline answers the expiry and removes the new ticket', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const clock = skewableClock();
  const mkdtempSync = fs.mkdtempSync;
  const created: string[] = [];
  const dirs = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
    const dir = mkdtempSync(prefix);
    if (String(prefix).includes('upload')) {
      created.push(String(dir));
      // The synchronous ticket creation crosses the aggregate; no timer callback can run.
      clock.skewMs = 600_001;
    }
    return dir;
  }) as typeof fs.mkdtempSync);
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const answered = await withIO(
      routeRequest(
        port,
        { method: 'POST', path: '/upload/preflight', headers: JSON_HEADERS },
        JSON.stringify({
          sha256: 'a'.repeat(64),
          uploadAttemptId: crypto.randomUUID(),
          fileName: 'artifact.bin',
          sizeBytes: 4,
          artifactType: 'file',
        }),
      ),
      'the preflight answer',
    );
    assert.equal(answered.status, 500);
    assert.equal(JSON.parse(answered.body).reason, 'transfer_ingress_deadline_exceeded');
    assert.equal(created.length, 1);
    assert.equal(fs.existsSync(created[0]!), false, 'the provisional ticket directory is removed');
  } finally {
    dirs.mockRestore();
    clock.restore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('an ignored PUT whose offset check crosses the deadline answers the expiry, not a 308', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bytes = Buffer.from('ABCD');
    const uploadId = await withIO(preflight(port, bytes), 'the preflight');
    const clock = skewableClock();
    const stat = fs.promises.stat.bind(fs.promises);
    const stats = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      target: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      const result = await stat(target, options);
      // The payload stat completes after the inactivity deadline, before its timer runs.
      if (String(target).endsWith('/payload')) clock.skewMs = 120_001;
      return result;
    }) as typeof fs.promises.stat);
    try {
      const answered = await withIO(
        routeRequest(
          port,
          {
            method: 'PUT',
            path: `/upload/direct/${uploadId}`,
            headers: { ...AUTH, 'content-range': 'bytes 2-3/4', 'content-length': '2' },
          },
          'CD',
        ),
        'the ignored PUT answer',
      );
      assert.equal(answered.status, 500, 'no 308 is committed after the deadline');
      assert.equal(JSON.parse(answered.body).reason, 'transfer_phase_timeout');
    } finally {
      stats.mockRestore();
      clock.restore();
    }
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a ticket expiring under a held first write never closes the socket under an earlier finalize', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const reads = holdPayloadReads((path) => String(path).endsWith('/payload'));
  const writeStarted = barrier();
  const releaseWrite = barrier();
  const createWriteStream = fs.createWriteStream;
  let holdWrites = false;
  const writers = vi.spyOn(fs, 'createWriteStream').mockImplementation((path, options) => {
    if (!holdWrites || typeof options !== 'object' || options.flags !== 'a') {
      return createWriteStream(path, options);
    }
    return createWriteStream(path, {
      ...options,
      fs: {
        open: fs.open,
        close: fs.close,
        write(...args) {
          writeStarted.resolve();
          void releaseWrite.promise.then(() => Reflect.apply(fs.write, fs, args));
        },
      },
    });
  });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Ticket B is created first and idles to one second before its 5-minute expiry.
    const bytesB = Buffer.from('WXYZ');
    const uploadB = await withIO(preflight(port, bytesB), 'preflight B');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1_000);
    const bytesA = Buffer.from('ABCD');
    const uploadA = await withIO(preflight(port, bytesA), 'preflight A');
    const putA = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadA}`,
          headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        bytesA,
      ),
      'chunk A',
    );
    assert.equal(putA.status, 200);
    holdWrites = true;

    // One keep-alive socket: a finalize for A (hash held), then a valid PUT for B whose
    // body is still arriving and whose first write is held while its ticket expires.
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    socket.on('data', (data: Buffer) => {
      received += data.toString('latin1');
    });
    socket.on('error', () => {});
    const finalizeBody = JSON.stringify({ uploadId: uploadA });
    socket.write(
      `POST /upload/finalize HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(finalizeBody)}\r\n\r\n${finalizeBody}` +
        `PUT /upload/direct/${uploadB} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `Content-Range: bytes 0-3/4\r\nContent-Length: 4\r\nConnection: close\r\n\r\nWX`,
    );
    await withIO(reads.started.promise, 'the held finalize hash');
    await withIO(writeStarted.promise, "B's held first write");
    // B's ticket idle timer fires while A's in-budget hash still owns the socket.
    await vi.advanceTimersByTimeAsync(2_000);
    await flushIO();
    assert.equal(socket.destroyed, false, 'the ticket expiry does not close the shared socket');
    reads.release.resolve();
    releaseWrite.resolve();
    await withIO(closed, 'the socket close after both answers');
    const statuses = [...received.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => match[1]);
    assert.equal(statuses[0], '200', 'A finalizes with its own answer');
    assert.equal(statuses[1], '404', 'B answers its typed ticket expiry');
    assert.match(received, /"reason":"RESOURCE_EXPIRED"/);
    const artifact = received.match(/"uploadId":"([^"]+)"/)?.[1];
    if (artifact) cleanupUploadedArtifact(artifact);
  } finally {
    reads.release.resolve();
    releaseWrite.resolve();
    reads.restore();
    writers.mockRestore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a preflight whose body completes past the deadline creates no ticket', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const clock = skewableClock();
  const mkdtempSync = fs.mkdtempSync;
  let ticketDirs = 0;
  const dirs = vi.spyOn(fs, 'mkdtempSync').mockImplementation(((prefix: string) => {
    if (String(prefix).includes('upload')) ticketDirs += 1;
    return mkdtempSync(prefix);
  }) as typeof fs.mkdtempSync);
  // The JSON body's last byte is read after the aggregate deadline, before its timer runs.
  server.prependOnceListener('request', (req: http.IncomingMessage) =>
    req.prependOnceListener('end', () => {
      clock.skewMs = 600_001;
    }),
  );
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const answered = await withIO(
      routeRequest(
        port,
        { method: 'POST', path: '/upload/preflight', headers: JSON_HEADERS },
        JSON.stringify({
          sha256: 'a'.repeat(64),
          uploadAttemptId: crypto.randomUUID(),
          fileName: 'artifact.bin',
          sizeBytes: 4,
          artifactType: 'file',
        }),
      ),
      'the preflight answer',
    );
    assert.equal(answered.status, 500);
    assert.equal(JSON.parse(answered.body).reason, 'transfer_ingress_deadline_exceeded');
    assert.equal(ticketDirs, 0, 'no ticket directory is created after the deadline');
  } finally {
    dirs.mockRestore();
    clock.restore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a chunk whose final offset check crosses the deadline rolls back instead of committing', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bytes = Buffer.from('ABCD');
    const uploadId = await withIO(preflight(port, bytes), 'the preflight');
    const clock = skewableClock();
    const stat = fs.promises.stat.bind(fs.promises);
    let payloadStats = 0;
    const stats = vi.spyOn(fs.promises, 'stat').mockImplementation((async (
      target: fs.PathLike,
      options?: fs.StatOptions,
    ) => {
      const result = await stat(target, options);
      // The second payload stat is the final offset check, after the body was appended.
      if (String(target).endsWith('/payload') && (payloadStats += 1) === 2) clock.skewMs = 600_001;
      return result;
    }) as typeof fs.promises.stat);
    const put = {
      method: 'PUT',
      path: `/upload/direct/${uploadId}`,
      headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
    };
    try {
      const answered = await withIO(routeRequest(port, put, bytes), 'the chunk answer');
      assert.equal(payloadStats, 2);
      assert.equal(answered.status, 500, 'the chunk offset is not committed after the deadline');
      assert.equal(JSON.parse(answered.body).reason, 'transfer_ingress_deadline_exceeded');
    } finally {
      stats.mockRestore();
      clock.restore();
    }
    // The chunk rolled back: a retry from offset zero completes.
    const retry = await withIO(routeRequest(port, put, bytes), 'the retry');
    assert.equal(retry.status, 200);
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

/**
 * One keep-alive socket: a finalize for A (hash held), then a stale-offset PUT for B that
 * the client keeps sending. B expires while queued. Resolves with the answers once the
 * socket closes cleanly; rejects on a reset.
 */
function pipelinedFinalizeThenStreamingPut(port: number, uploadA: string, uploadB: string) {
  const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
  let received = '';
  socket.on('data', (data: Buffer) => {
    received += data.toString('latin1');
  });
  const outcome = new Promise<string>((resolve, reject) => {
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (!hadError) resolve(received);
    });
  });
  const finalizeBody = JSON.stringify({ uploadId: uploadA });
  socket.write(
    `POST /upload/finalize HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(finalizeBody)}\r\n\r\n${finalizeBody}` +
      `PUT /upload/direct/${uploadB} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
      `Transfer-Encoding: chunked\r\n\r\n`,
  );
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const framed = Buffer.concat([
    Buffer.from(`${chunk.length.toString(16)}\r\n`),
    chunk,
    Buffer.from('\r\n'),
  ]);
  /** The client keeps sending B's body: 8 MiB more, then it ends its side. */
  const keepSending = () => {
    let sent = 0;
    const pump = () => {
      while (sent < 8 * 1024 * 1024 && socket.writable) {
        sent += chunk.length;
        if (!socket.write(framed)) {
          socket.once('drain', pump);
          return;
        }
      }
      if (socket.writable) socket.end();
    };
    pump();
  };
  return { socket, outcome, keepSending };
}

test('an expired queued request with an unread body never resets the earlier answer', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // A reset on close with unread body bytes is timing dependent, so the case repeats.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const reads = holdPayloadReads((path) => String(path).endsWith('/payload'));
      try {
        const bytesA = Buffer.from('ABCD');
        const uploadA = await withIO(preflight(port, bytesA), 'preflight A');
        const putA = await withIO(
          routeRequest(
            port,
            {
              method: 'PUT',
              path: `/upload/direct/${uploadA}`,
              headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
            },
            bytesA,
          ),
          'chunk A',
        );
        assert.equal(putA.status, 200);
        const sizeB = 64 * 1024 * 1024;
        const uploadB = await withIO(preflight(port, Buffer.alloc(0), sizeB), 'preflight B');
        await withIO(
          routeRequest(
            port,
            {
              method: 'PUT',
              path: `/upload/direct/${uploadB}`,
              headers: { ...AUTH, 'content-range': `bytes 0-0/${sizeB}`, 'content-length': '1' },
            },
            'a',
          ),
          'seed B',
        );
        const pipelined = pipelinedFinalizeThenStreamingPut(port, uploadA, uploadB);
        void pipelined.outcome.catch(() => {});
        await withIO(reads.started.promise, 'the held finalize hash');
        await flushIO();
        // B's inactivity ceiling passes while queued behind A's in-budget hash.
        await vi.advanceTimersByTimeAsync(150_000);
        reads.release.resolve();
        pipelined.keepSending();
        const received = await withIO(pipelined.outcome, 'a clean close after both answers');
        const statuses = [...received.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => match[1]);
        assert.deepEqual(statuses, ['200', '308'], 'the client reads both answers intact');
        const artifact = received.match(/"uploadId":"([^"]+)"/)?.[1];
        if (artifact) cleanupUploadedArtifact(artifact);
      } finally {
        reads.release.resolve();
        reads.restore();
      }
    }
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

// A guard, not a regression proof: it also passes before the forwarder change, because Node
// attaches no socket to a queued request. It pins the response order for a pipelined
// single-shot expiry.
test('guard: a single-shot upload expiring behind a long finalize keeps the earlier answer first', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const reads = holdPayloadReads((path) => String(path).endsWith('/payload'));
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const bytesA = Buffer.from('ABCD');
    const uploadA = await withIO(preflight(port, bytesA), 'preflight A');
    const putA = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadA}`,
          headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        bytesA,
      ),
      'chunk A',
    );
    assert.equal(putA.status, 200);

    // One keep-alive socket: a finalize for A (hash held), then a single-shot upload B
    // whose body stalls after its first bytes.
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (data: Buffer) => {
      received += data.toString('latin1');
    });
    socket.on('error', () => {});
    const finalizeBody = JSON.stringify({ uploadId: uploadA });
    socket.write(
      `POST /upload/finalize HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(finalizeBody)}\r\n\r\n${finalizeBody}` +
        `POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `X-Artifact-Type: file\r\nX-Artifact-Filename: single.bin\r\nContent-Length: 1000\r\n\r\n0123456789`,
    );
    await withIO(reads.started.promise, 'the held finalize hash');
    await flushIO();
    // B's 120 s inactivity ceiling passes while A's in-budget hash still owns the socket.
    await vi.advanceTimersByTimeAsync(150_000);
    await flushIO();
    assert.equal(socket.destroyed, false, "B's expiry does not close the socket under A");
    reads.release.resolve();
    const answers = receivedText(socket, () => (received.match(/HTTP\/1\.1 /g) ?? []).length >= 2);
    await withIO(answers, 'both answers');
    const statuses = [...received.matchAll(/HTTP\/1\.1 (\d+)/g)].map((match) => match[1]);
    assert.deepEqual(statuses, ['200', '500'], 'A finalizes, then B answers its typed expiry');
    assert.match(received, /"reason":"transfer_phase_timeout"/);
    const artifact = received.match(/"uploadId":"([^"]+)"/)?.[1];
    if (artifact) cleanupUploadedArtifact(artifact);
    socket.destroy();
  } finally {
    reads.release.resolve();
    reads.restore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a single-shot upload that expires mid-body answers a client that is still sending', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // A reset on close with unread body bytes is timing dependent, so the case repeats.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
      let received = '';
      let answered = false;
      const socketErrors: unknown[] = [];
      socket.on('error', (error) => socketErrors.push(error));
      // Resolves once the typed answer is read completely; rejects on a reset before it.
      const answer = new Promise<string>((resolve, reject) => {
        socket.on('data', (data: Buffer) => {
          received += data.toString('latin1');
          if (!answered && /\r\n\r\n\{.*\}$/s.test(received)) {
            answered = true;
            resolve(received);
          }
        });
        socket.on('error', (error) => {
          if (!answered) reject(error);
        });
      });
      void answer.catch(() => {});
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
          `X-Artifact-Type: file\r\nX-Artifact-Filename: single.bin\r\nContent-Length: ${64 * 1024 * 1024}\r\n\r\n`,
      );
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      // The body keeps making progress, so only the 600 s aggregate can end it. The last
      // step stops 1 s past the aggregate, inside the expired request's lingering grace.
      for (let step = 0; step < 10 && !answered; step += 1) {
        socket.write(chunk);
        await flushIO();
        await vi.advanceTimersByTimeAsync(step < 9 ? 61_000 : 52_000);
      }
      // The client is still sending when its typed answer arrives, as the remote upload
      // client does until it reads the answer.
      let sent = 0;
      const pump = () => {
        while (!answered && sent < 16 * 1024 * 1024 && socket.writable) {
          sent += chunk.length;
          if (!socket.write(chunk)) {
            socket.once('drain', pump);
            return;
          }
        }
      };
      pump();
      try {
        const read = await withIO(answer, 'the typed answer to a client still sending');
        assert.match(read, /^HTTP\/1\.1 500 /);
        // Under load a progress write can land after the 120 s ceiling; either typed
        // expiry is the owner's answer.
        assert.match(read, /"reason":"transfer_(ingress_deadline_exceeded|phase_timeout)"/);
        // The expiry did not destroy the connection: the server lingers and discards, so a
        // client that has not read its answer yet keeps sending without a reset.
        const sentAfterAnswer = new Promise<void>((resolve, reject) => {
          socket.once('error', reject);
          let more = 0;
          const pumpMore = () => {
            while (more < 4 * 1024 * 1024) {
              more += chunk.length;
              const last = more >= 4 * 1024 * 1024;
              const flushed = socket.write(chunk, last ? () => resolve() : undefined);
              if (!flushed && !last) {
                socket.once('drain', pumpMore);
                return;
              }
            }
          };
          pumpMore();
        });
        await withIO(sentAfterAnswer, 'the body bytes sent after the answer');
        await flushIO();
        assert.equal(socket.destroyed, false, 'the server did not reset the connection');
        // The server closes cleanly: it half-closed with a FIN after the answer, and its
        // lingering grace ends the connection without a reset.
        await vi.advanceTimersByTimeAsync(5_000);
        await flushIO();
        assert.equal(socket.readableEnded, true, 'the server sent a FIN, not a reset');
        assert.deepEqual(socketErrors, [], 'no reset reached the client');
      } finally {
        socket.destroy();
      }
    }
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a hash mismatch found past the deadline answers the deadline expiry', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  const reads = holdPayloadReads((path) => String(path).endsWith('/payload'));
  const clock = skewableClock();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // The ticket declares the hash of different bytes, so the finalize hash mismatches.
    const uploadId = await withIO(preflight(port, Buffer.from('WXYZ'), 4), 'the preflight');
    const put = await withIO(
      routeRequest(
        port,
        {
          method: 'PUT',
          path: `/upload/direct/${uploadId}`,
          headers: { ...AUTH, 'content-range': 'bytes 0-3/4', 'content-length': '4' },
        },
        'ABCD',
      ),
      'the chunk',
    );
    assert.equal(put.status, 200);
    const finalize = routeRequest(
      port,
      { method: 'POST', path: '/upload/finalize', headers: JSON_HEADERS },
      JSON.stringify({ uploadId }),
    );
    void finalize.catch(() => {});
    await withIO(reads.started.promise, 'the held hash read');
    clock.skewMs = 600_001;
    reads.release.resolve();
    const answered = await withIO(finalize, 'the finalize answer');
    assert.equal(answered.status, 500, 'the deadline, not the mismatch, is reported');
    assert.equal(JSON.parse(answered.body).reason, 'transfer_ingress_deadline_exceeded');
  } finally {
    reads.release.resolve();
    reads.restore();
    clock.restore();
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

test('a chunk refused by its byte cap lingers only for the grace, not the inactivity ceiling', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { server, port } = await startServer();
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const uploadId = await withIO(preflight(port, Buffer.alloc(0), 4), 'the preflight');
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    let received = '';
    socket.on('data', (data: Buffer) => {
      received += data.toString('latin1');
    });
    socket.on('error', () => {});
    const ended = new Promise<void>((resolve) => socket.once('end', () => resolve()));
    // A chunked body that overruns its 2-byte range: the limiter refuses it mid-body.
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    socket.write(
      `PUT /upload/direct/${uploadId} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        `Content-Range: bytes 0-1/4\r\nTransfer-Encoding: chunked\r\n\r\n`,
    );
    socket.write(
      Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from('\r\n')]),
    );
    const answer = receivedText(socket, () => /\r\n\r\n\{.*\}$/s.test(received));
    await withIO(answer, 'the byte-cap answer');
    assert.match(received, /^HTTP\/1\.1 400 /);
    // The rest of the refused body is discarded for at most the grace, then the server
    // closes its side of the connection, long before the 120 s inactivity ceiling.
    await withIO(ended, "the server's half-close after its answer");
    const openConnections = () =>
      new Promise<number>((resolve, reject) =>
        server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      );
    assert.equal(await openConnections(), 1);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushIO();
    assert.equal(await openConnections(), 0, 'the grace closed the connection');
    socket.destroy();
  } finally {
    vi.useRealTimers();
    await closeLoopbackServer(server);
  }
});

for (const route of ['/upload/preflight', '/upload/finalize']) {
  test(`an oversized JSON body on ${route} gets its 400 and a clean close while the client keeps sending`, async (t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const { server, port } = await startServer();
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
      let received = '';
      const socketErrors: unknown[] = [];
      socket.on('error', (error) => socketErrors.push(error));
      socket.on('data', (data: Buffer) => {
        received += data.toString('latin1');
      });
      // A chunked body declares no length, so the reader refuses it as it passes 64 KiB.
      socket.write(
        `POST ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${TOKEN}\r\n` +
          `Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`,
      );
      const chunk = Buffer.alloc(16 * 1024, 0x20);
      const framed = Buffer.concat([
        Buffer.from(`${chunk.length.toString(16)}\r\n`),
        chunk,
        Buffer.from('\r\n'),
      ]);
      // The client keeps sending 2 MiB, well past the refusal, as a client that has not
      // read its answer yet would.
      const sent = new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        let total = 0;
        const pump = () => {
          while (total < 2 * 1024 * 1024) {
            total += chunk.length;
            const last = total >= 2 * 1024 * 1024;
            const flushed = socket.write(framed, last ? () => resolve() : undefined);
            if (!flushed && !last) {
              socket.once('drain', pump);
              return;
            }
          }
        };
        pump();
      });
      await withIO(sent, 'the oversized body sent past the refusal');
      await flushIO();
      assert.match(received, /^HTTP\/1\.1 400 /, 'the client reads its typed refusal');
      assert.equal(socket.readableEnded, true, 'the server half-closed with a FIN');
      assert.deepEqual(socketErrors, [], 'no reset reached the client');
      // After its lingering grace the server closes the connection.
      const openConnections = () =>
        new Promise<number>((resolve, reject) =>
          server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
        );
      await vi.advanceTimersByTimeAsync(5_000);
      await flushIO();
      assert.equal(await openConnections(), 0);
      assert.deepEqual(socketErrors, []);
      socket.destroy();
    } finally {
      vi.useRealTimers();
      await closeLoopbackServer(server);
    }
  });
}
