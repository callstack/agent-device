import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { isTransferPhaseTimeoutError } from '@agent-device/host-kit/transport';
import {
  createNodeTransferFetch,
  isTransferRoute,
  settleUpstreamFetch,
  transferWireDetails,
} from './transfer-transport.ts';

/**
 * These cases run the real `node:http` client against real loopback servers, so they exercise the
 * event order the transport depends on. Nothing here waits on a real 30- or 120-second ceiling: the
 * phase budgets are covered at their owner in `@agent-device/host-kit` transport tests, and the
 * budget arithmetic a transfer applies is asserted from the typed reason each failure carries.
 */

const servers: http.Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

/** Starts a loopback upstream and returns its origin. */
function startUpstream(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function transferFetch() {
  return createNodeTransferFetch();
}

/** A streamed body that keeps producing chunks, so backpressure and drain waits are exercised. */
function streamedBody(totalBytes: number, chunkBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
}

test('the transfer route set covers the artifact routes and leaves the Fetch routes alone', () => {
  expect(
    [
      isTransferRoute('/upload', 'POST'),
      isTransferRoute('/upload/preflight', 'POST'),
      isTransferRoute('/upload/finalize', 'POST'),
      isTransferRoute('/upload/direct/abc', 'PUT'),
      isTransferRoute('/artifacts', 'GET'),
      isTransferRoute('/artifacts/art-1', 'GET'),
    ].every(Boolean),
  ).toBe(true);

  expect(
    [
      isTransferRoute('/rpc', 'POST'),
      isTransferRoute('/health', 'GET'),
      isTransferRoute('/sessions/s1/requests/r1/diagnostics', 'GET'),
      isTransferRoute('/upload', 'GET'),
      isTransferRoute('/upload/direct/abc', 'POST'),
      isTransferRoute('/artifacts/art-1', 'POST'),
      isTransferRoute('/upload/direct', 'PUT'),
    ].some(Boolean),
  ).toBe(false);
});

test('a location-less 308 chunk answer keeps its resume offsets', async () => {
  const origin = await startUpstream((_req, res) => {
    res.writeHead(308, { range: 'bytes=0-1023', 'x-upload-offset': '1024' });
    res.end();
  });

  const response = await transferFetch()(
    new Request(`${origin}/upload/direct/abc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1024));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit),
  );

  expect(response.status).toBe(308);
  expect(response.headers.get('x-upload-offset')).toBe('1024');
  expect(response.headers.get('range')).toBe('bytes=0-1023');
  expect(response.headers.get('location')).toBeNull();
  await response.text();
});

test('a redirect with a Location is answered as a status, never followed', async () => {
  const followed = await startUpstream((_req, res) => {
    res.statusCode = 200;
    res.end('followed');
  });
  const origin = await startUpstream((_req, res) => {
    res.writeHead(307, { location: `${followed}/artifacts/art-1` });
    res.end();
  });

  const response = await transferFetch()(
    new Request(`${origin}/artifacts/art-1`, { method: 'GET' }),
  );

  expect(response.status).toBe(307);
  expect(await response.text()).toBe('');
});

test('an early 413 keeps its own status against a later peer break', async () => {
  let upstreamRequest!: IncomingMessage;
  const origin = await startUpstream((req, res) => {
    upstreamRequest = req;
    req.on('error', () => undefined);
    res.statusCode = 413;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Artifact upload is too large' }));
  });

  const response = await transferFetch()(
    new Request(`${origin}/upload/direct/abc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 32; i += 1) controller.enqueue(new Uint8Array(64 * 1024));
        },
      }),
      duplex: 'half',
    } as RequestInit),
  );

  expect(response.status).toBe(413);
  upstreamRequest.destroy();
  expect((await response.json()) as unknown).toEqual({
    ok: false,
    error: 'Artifact upload is too large',
  });
});

test('an upload that is read completely answers with its status and streamed body', async () => {
  const origin = await startUpstream(async (req, res) => {
    let received = 0;
    for await (const chunk of req) received += (chunk as Buffer).byteLength;
    res.statusCode = 200;
    res.end(`received:${received}`);
  });

  const response = await transferFetch()(
    new Request(`${origin}/upload/direct/abc`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: streamedBody(256 * 1024, 16 * 1024),
      duplex: 'half',
    } as RequestInit),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe('received:262144');
});

test('a download body is handed over in order and ends exactly once', async () => {
  const origin = await startUpstream((_req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/octet-stream');
    res.write(Buffer.alloc(1024, 0x62));
    res.write(Buffer.alloc(1024, 0x63));
    res.end();
  });

  const response = await transferFetch()(new Request(`${origin}/artifacts/art-1`));

  expect(response.status).toBe(200);
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body).toHaveLength(2048);
  expect(body[0]).toBe(0x62);
  expect(body[1024]).toBe(0x63);
});

test('a null-body status and a HEAD answer carry headers with no body', async () => {
  const origin = await startUpstream((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-length': '4096' });
      res.end();
      return;
    }
    res.writeHead(204, { 'x-artifact': 'gone' });
    res.end();
  });
  const fetchTransfer = transferFetch();

  const head = await fetchTransfer(new Request(`${origin}/artifacts/art-1`, { method: 'HEAD' }));
  const noContent = await fetchTransfer(new Request(`${origin}/artifacts/art-1`));

  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe('4096');
  expect(head.body).toBeNull();
  expect(noContent.status).toBe(204);
  expect(noContent.headers.get('x-artifact')).toBe('gone');
  expect(noContent.body).toBeNull();
});

test('caller cancellation is reported with the caller reason verbatim', async () => {
  const origin = await startUpstream(() => undefined);
  const caller = new AbortController();
  const cancellation = new Error('caller went away');

  const pending = transferFetch()(
    new Request(`${origin}/artifacts/art-1`, { signal: caller.signal }),
  );
  caller.abort(cancellation);

  await expect(pending).rejects.toBe(cancellation);
});

test('an upstream that dies before answering fails without a phase reason', async () => {
  const origin = await startUpstream((req) => {
    req.destroy();
  });

  await expect(transferFetch()(new Request(`${origin}/artifacts/art-1`))).rejects.toBeInstanceOf(
    Error,
  );
});

test('a forwarded request carries its method, path, query and allowed headers', async () => {
  let seen: IncomingMessage | undefined;
  const origin = await startUpstream((req, res) => {
    seen = req;
    res.statusCode = 200;
    res.end('ok');
  });

  const response = await transferFetch()(
    new Request(`${origin}/artifacts/art-1?version=2`, {
      headers: { 'x-artifact-hash': 'sha256:abc', authorization: 'Bearer daemon-secret' },
    }),
  );
  await response.text();

  expect(seen?.method).toBe('GET');
  expect(seen?.url).toBe('/artifacts/art-1?version=2');
  expect(seen?.headers['x-artifact-hash']).toBe('sha256:abc');
  expect(seen?.headers.authorization).toBe('Bearer daemon-secret');
});

test('the default transport injects neither Fetch headers nor URL authorization', async () => {
  let headers: http.IncomingHttpHeaders = {};
  const origin = await startUpstream((req, res) => {
    headers = req.headers;
    res.end('ok');
  });
  const response = await transferFetch()(new Request(`${origin}/artifacts/art-1`));
  expect(await response.text()).toBe('ok');
  expect(headers.authorization).toBeUndefined();
  expect(headers.accept).toBeUndefined();
  expect(headers['user-agent']).toBeUndefined();
});

test('a custom transport keeps its response body for the caller', async () => {
  const response = await settleUpstreamFetch(
    () =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    new Request('http://daemon.internal:4310/upload/preflight', { method: 'POST' }),
  );

  expect(response.status).toBe(201);
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.text()).toBe('{"ok":true}');
});

test('the default transport serves an unchunked body whose length is known up front', async () => {
  const payload = Buffer.alloc(4096, 0x7a);
  const origin = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-length': String(payload.byteLength) });
    res.end(payload);
  });

  const response = await transferFetch()(new Request(`${origin}/artifacts/art-1`));

  expect(response.status).toBe(200);
  const body = new Uint8Array(await response.arrayBuffer());
  expect(body).toHaveLength(4096);
  expect(body.every((byte) => byte === 0x7a)).toBe(true);
});

test('the forwarding aggregate ends a transport that never settles and names its phase', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = settleUpstreamFetch(
      () => new Promise<Response>(() => undefined),
      new Request('http://daemon.internal:4310/artifacts/art-1'),
    );
    let settled = false;
    const failure = pending.catch((error: unknown) => error);
    void failure.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(600_000 + 1);
    expect(settled).toBe(true);
    const error = await failure;
    assert.ok(error instanceof AppError);
    assert.equal(isTransferPhaseTimeoutError(error), false);
    expect(error.details).toEqual({
      reason: 'transfer_forwarding_deadline_exceeded',
      transferPhase: 'forwarding',
      timeoutMs: 600_000,
    });
  } finally {
    vi.useRealTimers();
  }
});

test('a transfer failure exposes the adopted wire details and nothing else does', () => {
  const phaseFailure = new AppError(
    'COMMAND_FAILED',
    'Artifact transfer response-headers timed out',
    {
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-headers',
      timeoutMs: 30_000,
    },
  );

  expect(transferWireDetails(phaseFailure)).toEqual({
    reason: 'transfer_phase_timeout',
    transferPhase: 'response-headers',
    timeoutMs: 30_000,
  });
  expect(
    transferWireDetails(
      new AppError('COMMAND_FAILED', 'Proxy transfer forwarding deadline exceeded', {
        reason: 'transfer_forwarding_deadline_exceeded',
        transferPhase: 'forwarding',
        timeoutMs: 600_000,
      }),
    ),
  ).toEqual({
    reason: 'transfer_forwarding_deadline_exceeded',
    transferPhase: 'forwarding',
    timeoutMs: 600_000,
  });
  expect(
    transferWireDetails(new AppError('UNAUTHORIZED', 'Invalid proxy token', { reason: 'other' })),
  ).toEqual({});
  expect(transferWireDetails(new Error('socket hang up'))).toEqual({});
});

test('a transfer failure with unusable details stays off the wire', () => {
  expect(
    transferWireDetails(
      new AppError('COMMAND_FAILED', 'masked', {
        reason: 'transfer_phase_timeout',
        transferPhase: '',
        timeoutMs: 30_000,
      }),
    ),
  ).toEqual({});
  expect(
    transferWireDetails(
      new AppError('COMMAND_FAILED', 'masked', {
        reason: 'transfer_phase_timeout',
        transferPhase: 'response-body',
        timeoutMs: Number.NaN,
      }),
    ),
  ).toEqual({});
  expect(
    transferWireDetails(
      new AppError('COMMAND_FAILED', 'masked', {
        reason: 'transfer_phase_timeout',
        transferPhase: 'response-body',
      }),
    ),
  ).toEqual({});
});
