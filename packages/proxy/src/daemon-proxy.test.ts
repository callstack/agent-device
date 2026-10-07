import { expect, test } from 'vitest';
import { createDaemonProxy, type DaemonProxyUpstreamFetch } from './daemon-proxy.ts';

const PROXY_ORIGIN = 'https://gateway.example.test';

function recordingUpstream(respond: (request: Request) => Response | Promise<Response>): {
  fetch: DaemonProxyUpstreamFetch;
  requests: Request[];
} {
  const requests: Request[] = [];
  return {
    requests,
    fetch: async (request) => {
      requests.push(request);
      return await respond(request);
    },
  };
}

function signalled(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function proxyWith(upstreamFetch: DaemonProxyUpstreamFetch, maxRpcBodyBytes?: number) {
  return createDaemonProxy({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch,
    ...(maxRpcBodyBytes !== undefined ? { maxRpcBodyBytes } : {}),
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

test('rpc reaches the daemon through the supplied upstream transport with the daemon token', async () => {
  const upstream = recordingUpstream(async (request) =>
    Response.json({ jsonrpc: '2.0', id: 1, echo: await request.json() }),
  );
  const proxy = proxyWith(upstream.fetch);

  const response = await proxy.handle(
    rpcRequest({ jsonrpc: '2.0', id: 1, method: 'agent-device.command', params: { token: 'x' } }),
  );

  expect(response.status).toBe(200);
  const [forwarded] = upstream.requests;
  expect(forwarded?.url).toBe('http://daemon.internal:4310/rpc');
  expect(forwarded?.headers.get('authorization')).toBe('Bearer daemon-secret');
  const payload = (await response.json()) as { echo: { params: { token: string } } };
  expect(payload.echo.params.token).toBe('daemon-secret');
});

test('a request without the client token never reaches the upstream transport', async () => {
  const upstream = recordingUpstream(() => Response.json({}));
  const proxy = proxyWith(upstream.fetch);

  const response = await proxy.handle(
    rpcRequest({ jsonrpc: '2.0', id: 7, method: 'agent-device.command' }, { headers: {} }),
  );

  expect(response.status).toBe(401);
  expect(upstream.requests).toHaveLength(0);
});

test('aborting the client request aborts the upstream exchange', async () => {
  const upstreamReceived = signalled();
  const upstreamAborted = signalled();
  const proxy = proxyWith(
    (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          upstreamAborted.resolve();
          reject(request.signal.reason);
        });
        upstreamReceived.resolve();
      }),
  );
  const client = new AbortController();

  const response = proxy.handle(
    rpcRequest(
      { jsonrpc: '2.0', id: 2, method: 'agent-device.command' },
      { signal: client.signal },
    ),
  );
  await upstreamReceived.promise;
  client.abort();

  await upstreamAborted.promise;
  expect((await response).status).toBe(500);
});

test('upload tickets point at the origin the client used, not the daemon', async () => {
  const upstream = recordingUpstream(() =>
    Response.json({
      ok: true,
      upload: { url: 'http://127.0.0.1:4310/upload/direct/abc?part=1', headers: {} },
    }),
  );
  const proxy = proxyWith(upstream.fetch);

  const response = await proxy.handle(
    new Request(`${PROXY_ORIGIN}/agent-device/upload/preflight`, {
      method: 'POST',
      headers: { authorization: 'Bearer client-secret' },
      body: '{}',
    }),
  );

  const payload = (await response.json()) as {
    upload: { url: string; headers: Record<string, string> };
  };
  expect(payload.upload.url).toBe(`${PROXY_ORIGIN}/agent-device/upload/direct/abc?part=1`);
  expect(payload.upload.headers.authorization).toBe('Bearer client-secret');
});

test('an oversized rpc body resolves with a 400 instead of rejecting', async () => {
  const upstream = recordingUpstream(() => Response.json({}));
  const proxy = proxyWith(upstream.fetch, 16);

  const response = await proxy.handle(
    rpcRequest({ jsonrpc: '2.0', id: 3, method: 'agent-device.command', padding: 'x'.repeat(64) }),
  );

  expect(response.status).toBe(400);
  expect(upstream.requests).toHaveLength(0);
});

test('aborting a health request aborts the upstream health probe', async () => {
  const upstreamReceived = signalled();
  const upstreamAborted = signalled();
  const proxy = proxyWith(
    (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          upstreamAborted.resolve();
          reject(request.signal.reason);
        });
        upstreamReceived.resolve();
      }),
  );
  const client = new AbortController();

  const response = proxy.handle(
    new Request(`${PROXY_ORIGIN}/agent-device/health`, { signal: client.signal }),
  );
  await upstreamReceived.promise;
  client.abort();

  await upstreamAborted.promise;
  expect((await response).status).toBe(500);
});

test('an unsupported route answers a bare 404 without reaching the daemon', async () => {
  const upstream = recordingUpstream(() => Response.json({}));
  const proxy = proxyWith(upstream.fetch);

  const response = await proxy.handle(
    new Request(`${PROXY_ORIGIN}/admin/leases/lease-1`, {
      headers: { authorization: 'Bearer client-secret' },
    }),
  );

  expect(response.status).toBe(404);
  expect(response.headers.get('content-type')).toBeNull();
  expect(upstream.requests).toHaveLength(0);
});
