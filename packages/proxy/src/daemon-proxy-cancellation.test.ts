import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, onTestFinished, test, vi } from 'vitest';
import {
  createDaemonProxy,
  createDaemonProxyServer,
  type DaemonProxyUpstreamFetch,
} from './daemon-proxy.ts';

const PROXY_ORIGIN = 'https://gateway.example.test';

function signalled(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Runs the collection a long-lived proxy eventually runs, so a test sees what an unreferenced
 * request loses. A weak reference keeps its target until the job that created it ends.
 */
async function collectGarbage(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

/** A transport that answers only when its request aborts. */
function abortObservingUpstream(): {
  fetch: DaemonProxyUpstreamFetch;
  received: Promise<void>;
  aborted: Promise<void>;
} {
  const received = signalled();
  const aborted = signalled();
  return {
    received: received.promise,
    aborted: aborted.promise,
    fetch: (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          aborted.resolve();
          reject(request.signal.reason);
        });
        received.resolve();
      }),
  };
}

function proxyWith(upstreamFetch: DaemonProxyUpstreamFetch) {
  return createDaemonProxy({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch,
  });
}

function rpcRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request(`${PROXY_ORIGIN}/agent-device/rpc`, {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

test.each([
  {
    route: 'rpc',
    request: (signal: AbortSignal) =>
      rpcRequest({ jsonrpc: '2.0', id: 2, method: 'agent-device.command' }, { signal }),
  },
  {
    route: 'health',
    request: (signal: AbortSignal) =>
      new Request(`${PROXY_ORIGIN}/agent-device/health`, { signal }),
  },
  {
    route: 'artifact download',
    request: (signal: AbortSignal) =>
      new Request(`${PROXY_ORIGIN}/agent-device/artifacts/art-1`, {
        headers: { authorization: 'Bearer client-secret' },
        signal,
      }),
  },
])(
  'aborting the client request after a garbage collection aborts the upstream $route exchange',
  async ({ request }) => {
    const upstream = abortObservingUpstream();
    const proxy = proxyWith(upstream.fetch);
    const client = new AbortController();

    // Like an embedder, the test keeps its request while the proxy answers it.
    const clientRequest = request(client.signal);
    const response = proxy.handle(clientRequest);
    await upstream.received;
    await collectGarbage();
    client.abort();

    await upstream.aborted;
    expect((await response).status).toBe(500);
  },
);

test('a health request handled by two proxies at once aborts both upstream probes after a garbage collection', async () => {
  const first = abortObservingUpstream();
  const second = abortObservingUpstream();
  const client = new AbortController();
  // Like an embedder, the test keeps its request while the proxies answer it.
  const clientRequest = new Request(`${PROXY_ORIGIN}/agent-device/health`, {
    signal: client.signal,
  });

  const responses = Promise.all([
    proxyWith(first.fetch).handle(clientRequest),
    proxyWith(second.fetch).handle(clientRequest),
  ]);
  await Promise.all([first.received, second.received]);
  await collectGarbage();
  client.abort();

  await Promise.all([first.aborted, second.aborted]);
  expect((await responses).map((response) => response.status)).toEqual([500, 500]);
});

test('a client leaving the Node adapter mid-response after a garbage collection aborts the upstream request', async () => {
  const upstreamAborted = signalled();
  const server = createDaemonProxyServer({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch: async (request) => {
      request.signal.addEventListener('abort', () => upstreamAborted.resolve(), { once: true });
      return new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{}\n')),
        }),
      );
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const client = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/agent-device/rpc',
      headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    });
    client.on('error', () => {});
    const firstChunk = new Promise<void>((resolve) => {
      client.on('response', (response) => response.once('data', () => resolve()));
    });
    client.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'agent-device.command' }));
    await firstChunk;
    await collectGarbage();
    client.destroy();

    await upstreamAborted.promise;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the upstream health probe has its own bound without upstreamTimeoutMs', async () => {
  const healthBound = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(healthBound.signal);
  // A timed-out test never reaches a `finally`; the real timer test below needs the spy gone.
  onTestFinished(() => timeout.mockRestore());
  const upstream = abortObservingUpstream();
  const proxy = proxyWith(upstream.fetch);
  const clientRequest = new Request(`${PROXY_ORIGIN}/agent-device/health`);

  const response = proxy.handle(clientRequest);
  expect(timeout.mock.calls).toEqual([[5_000]]);
  await upstream.received;
  await collectGarbage();
  healthBound.abort();

  await upstream.aborted;
  expect((await response).status).toBe(500);
});

test('upstreamTimeoutMs still ends an rpc exchange after a garbage collection', async () => {
  const upstream = abortObservingUpstream();
  const proxy = createDaemonProxy({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch: upstream.fetch,
    // A real timer, long enough that the collection below runs before it fires.
    upstreamTimeoutMs: 300,
  });
  const clientRequest = rpcRequest({
    jsonrpc: '2.0',
    id: 5,
    method: 'agent-device.command',
    params: {},
  });

  const response = proxy.handle(clientRequest);
  await upstream.received;
  await collectGarbage();

  await upstream.aborted;
  expect((await response).status).toBe(500);
});

test('aborting the client request after a garbage collection aborts a pending authenticate', async () => {
  const authenticateReceived = signalled();
  const authenticateAborted = signalled();
  const proxy = createDaemonProxy({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    upstreamFetch: async () => Response.json({}),
    authenticate: (request) =>
      new Promise<null>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          authenticateAborted.resolve();
          reject(request.signal.reason);
        });
        authenticateReceived.resolve();
      }),
  });
  const client = new AbortController();

  const clientRequest = rpcRequest(
    { jsonrpc: '2.0', id: 6, method: 'agent-device.command' },
    { signal: client.signal },
  );
  const response = proxy.handle(clientRequest);
  await authenticateReceived.promise;
  await collectGarbage();
  client.abort();

  await authenticateAborted.promise;
  expect((await response).status).toBe(500);
});
