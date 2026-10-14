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

test('a partial upload chunk answer keeps the resume offset headers', async () => {
  const upstream = recordingUpstream(
    () =>
      new Response(null, {
        status: 308,
        headers: { range: 'bytes=0-1023', 'x-upload-offset': '1024' },
      }),
  );
  const proxy = proxyWith(upstream.fetch);

  const response = await proxy.handle(
    new Request(`${PROXY_ORIGIN}/agent-device/upload/direct/abc`, {
      method: 'PUT',
      headers: { authorization: 'Bearer client-secret', 'content-range': 'bytes 0-2047/4096' },
      body: 'x'.repeat(2048),
      duplex: 'half',
    } as RequestInit),
  );

  expect(response.status).toBe(308);
  expect(response.headers.get('range')).toBe('bytes=0-1023');
  expect(response.headers.get('x-upload-offset')).toBe('1024');
});

test('an artifact download keeps the upstream content-length', async () => {
  const upstream = recordingUpstream(
    () =>
      new Response('artifact-bytes', {
        headers: { 'content-type': 'application/zip', 'content-length': '14' },
      }),
  );
  const proxy = proxyWith(upstream.fetch);

  const response = await proxy.handle(
    new Request(`${PROXY_ORIGIN}/agent-device/artifacts/art-1`, {
      headers: { authorization: 'Bearer client-secret' },
    }),
  );

  expect(response.headers.get('content-length')).toBe('14');
  expect(await response.text()).toBe('artifact-bytes');
});

test('a rewritten upload ticket drops the upstream content-length', async () => {
  const upstreamBody = JSON.stringify({
    ok: true,
    upload: { url: 'http://127.0.0.1:4310/upload/direct/abc', headers: {} },
  });
  const upstream = recordingUpstream(
    () =>
      new Response(upstreamBody, {
        headers: {
          'content-type': 'application/json',
          'content-length': String(upstreamBody.length),
        },
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

  expect(response.headers.get('content-length')).toBeNull();
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

function proxyAuthenticatingWith(upstreamFetch: DaemonProxyUpstreamFetch) {
  const seen: Request[] = [];
  const proxy = createDaemonProxy({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    upstreamFetch,
    authenticate: async (request) => {
      seen.push(request);
      const token = request.headers.get('authorization');
      if (token === 'Bearer alice-key') return { tenantId: 'alice' };
      if (token === 'Bearer bob-key') return { tenantId: 'bob' };
      return null;
    },
  });
  return { proxy, seen };
}

function forwardedParams(request: Request | undefined): Promise<Record<string, unknown>> {
  return request!.json().then((body) => (body as { params: Record<string, unknown> }).params);
}

test('authenticate refuses a caller it returns null for with the unauthorized rpc envelope', async () => {
  const upstream = recordingUpstream(() => Response.json({}));
  const { proxy } = proxyAuthenticatingWith(upstream.fetch);

  const response = await proxy.handle(
    rpcRequest(
      { jsonrpc: '2.0', id: 9, method: 'agent-device.command' },
      {
        headers: { authorization: 'Bearer client-secret' },
      },
    ),
  );

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    id: 9,
    error: { code: -32001, data: { code: 'UNAUTHORIZED' } },
  });
  expect(upstream.requests).toHaveLength(0);
});

test('authenticate sees the rpc body and its tenant overwrites the tenant a command declares', async () => {
  const upstream = recordingUpstream(() => Response.json({ jsonrpc: '2.0', id: 1, result: {} }));
  const { proxy, seen } = proxyAuthenticatingWith(upstream.fetch);

  const response = await proxy.handle(
    rpcRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent-device.command',
        params: {
          command: 'devices',
          flags: { tenant: 'bob', sessionIsolation: 'none' },
          meta: { tenantId: 'bob', sessionIsolation: 'none', requestId: 'r1' },
        },
      },
      { headers: { authorization: 'Bearer alice-key' } },
    ),
  );

  expect(response.status).toBe(200);
  expect((await forwardedParams(seen[0])).command).toBe('devices');
  const params = await forwardedParams(upstream.requests[0]);
  expect(params.meta).toEqual({ tenantId: 'alice', sessionIsolation: 'tenant', requestId: 'r1' });
  expect(params.flags).toEqual({ tenant: 'alice', sessionIsolation: 'tenant' });
  expect(params.token).toBe('daemon-secret');
});

test('authenticate tenant overwrites the tenant a lease call declares', async () => {
  const upstream = recordingUpstream(() => Response.json({ jsonrpc: '2.0', id: 1, result: {} }));
  const { proxy } = proxyAuthenticatingWith(upstream.fetch);

  await proxy.handle(
    rpcRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent_device.lease.allocate',
        params: { tenantId: 'bob', runId: 'run-1' },
      },
      { headers: { authorization: 'Bearer alice-key' } },
    ),
  );

  expect((await forwardedParams(upstream.requests[0])).tenantId).toBe('alice');
});

test('authenticate tenant replaces the tenant header a client sends on artifact routes', async () => {
  const upstream = recordingUpstream(() => Response.json({ artifacts: [] }));
  const { proxy } = proxyAuthenticatingWith(upstream.fetch);

  await proxy.handle(
    new Request(`${PROXY_ORIGIN}/agent-device/artifacts`, {
      headers: { authorization: 'Bearer alice-key', 'x-agent-device-tenant': 'bob' },
    }),
  );

  expect(upstream.requests[0]?.headers.get('x-agent-device-tenant')).toBe('alice');
});

test('with authenticate, upload tickets carry the caller credential', async () => {
  const upstream = recordingUpstream(() =>
    Response.json({
      ok: true,
      upload: { url: 'http://127.0.0.1:4310/upload/direct/abc', headers: { 'x-extra': '1' } },
    }),
  );
  const { proxy } = proxyAuthenticatingWith(upstream.fetch);

  const response = await proxy.handle(
    new Request(`${PROXY_ORIGIN}/agent-device/upload/preflight`, {
      method: 'POST',
      headers: { authorization: 'Bearer bob-key' },
      body: '{}',
    }),
  );

  const payload = (await response.json()) as { upload: { headers: Record<string, string> } };
  expect(payload.upload.headers).toEqual({ 'x-extra': '1', authorization: 'Bearer bob-key' });
});

test('with authenticate, request diagnostics are served only for the caller tenant sessions', async () => {
  const upstream = recordingUpstream(() => Response.json({ ok: true }));
  const { proxy } = proxyAuthenticatingWith(upstream.fetch);
  const diagnostics = (session: string) =>
    proxy.handle(
      new Request(
        `${PROXY_ORIGIN}/agent-device/sessions/${encodeURIComponent(session)}/requests/r1/diagnostics`,
        { headers: { authorization: 'Bearer alice-key' } },
      ),
    );

  const other = await diagnostics('bob:default');
  const own = await diagnostics('alice:default');

  expect(other.status).toBe(401);
  expect(own.status).toBe(200);
  expect(upstream.requests).toHaveLength(1);
});

test('without authenticate, the tenant a client declares is forwarded unchanged', async () => {
  const upstream = recordingUpstream(() => Response.json({ jsonrpc: '2.0', id: 1, result: {} }));
  const proxy = proxyWith(upstream.fetch);

  await proxy.handle(
    rpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'agent-device.command',
      params: { command: 'devices', meta: { tenantId: 'bob' } },
    }),
  );

  const params = await forwardedParams(upstream.requests[0]);
  expect(params.meta).toEqual({ tenantId: 'bob' });
  expect(params.tenantId).toBeUndefined();
});
