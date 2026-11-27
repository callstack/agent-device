import { expect, test } from 'vitest';
import {
  DAEMON_HTTP_CHECKED_RPC_CAPABILITY,
  DAEMON_HTTP_REFUSAL_HEADER,
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { createDaemonProxy, type DaemonProxyUpstreamFetch } from './daemon-proxy.ts';

const PROXY_ORIGIN = 'https://gateway.example.test';
const PROTOCOL = String(DAEMON_RPC_PROTOCOL_VERSION);

function recordingUpstream(respond: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetch: DaemonProxyUpstreamFetch = async (request) => {
    requests.push(request);
    return await respond(request);
  };
  return { requests, fetch };
}

function tokenProxy(upstreamFetch: DaemonProxyUpstreamFetch) {
  return createDaemonProxy({
    upstreamBaseUrl: 'http://daemon.internal:4310',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch,
  });
}

function checkedRequest(
  body: unknown,
  headers: Record<string, string> = { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: PROTOCOL },
  route = 'rpc/checked',
): Request {
  return new Request(`${PROXY_ORIGIN}/agent-device/${route}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const COMMAND = { jsonrpc: '2.0', id: 1, method: 'agent_device.command', params: {} };

test('a checked call reaches the upstream checked route with the same rewriting as /rpc', async () => {
  const upstream = recordingUpstream(async (request) =>
    Response.json({ jsonrpc: '2.0', id: 1, echo: await request.json() }),
  );
  const response = await tokenProxy(upstream.fetch).handle(checkedRequest(COMMAND));

  expect(response.status).toBe(200);
  const [forwarded] = upstream.requests;
  expect(forwarded?.url).toBe('http://daemon.internal:4310/rpc/checked');
  expect(forwarded?.headers.get('authorization')).toBe('Bearer daemon-secret');
  expect(forwarded?.headers.get(DAEMON_HTTP_RPC_PROTOCOL_HEADER)).toBe(PROTOCOL);
  expect(forwarded?.headers.get('x-agent-device-network-access')).toBe('public-only');
  const payload = (await response.json()) as { echo: { params: { token: string } } };
  expect(payload.echo.params.token).toBe('daemon-secret');
});

test.each([
  ['protocol-mismatch', { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: '999' }],
  ['protocol-missing', {}],
])(
  'an authenticated checked call with %s is refused by the proxy before forwarding',
  async (refusal, headers) => {
    const upstream = recordingUpstream(() => Response.json({}));
    const response = await tokenProxy(upstream.fetch).handle(checkedRequest(COMMAND, headers));

    expect(response.status).toBe(409);
    expect(response.headers.get(DAEMON_HTTP_REFUSAL_HEADER)).toBe(refusal);
    const body = (await response.json()) as {
      error: { data: { details: Record<string, unknown> } };
    };
    expect(body.error.data.details).toMatchObject({
      service: 'agent-device-proxy',
      rpcProtocolVersion: DAEMON_RPC_PROTOCOL_VERSION,
      dispatched: 'no',
    });
    expect(upstream.requests).toHaveLength(0);
  },
);

test('an unauthenticated checked call learns nothing about the proxy protocol', async () => {
  const upstream = recordingUpstream(() => Response.json({}));
  const response = await tokenProxy(upstream.fetch).handle(
    checkedRequest(COMMAND, {
      [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: '999',
      authorization: 'Bearer wrong',
    }),
  );

  expect(response.status).toBe(401);
  expect(response.headers.get(DAEMON_HTTP_REFUSAL_HEADER)).toBeNull();
  expect(upstream.requests).toHaveLength(0);
});

test.each(['rpc', 'rpc/checked'])(
  'a tenant-restricted method is refused on /%s before the daemon',
  async (route) => {
    const upstream = recordingUpstream(() => Response.json({}));
    const proxy = createDaemonProxy({
      upstreamBaseUrl: 'http://daemon.internal:4310',
      upstreamToken: 'daemon-secret',
      authenticate: () => ({ tenantId: 'tenant-a' }),
      upstreamFetch: upstream.fetch,
    });
    const response = await proxy.handle(
      checkedRequest(
        { jsonrpc: '2.0', id: 2, method: 'agent_device.install_from_source', params: {} },
        { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: PROTOCOL },
        route,
      ),
    );

    expect(response.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  },
);

test('the upstream protocol refusal reaches the client marked as the daemon behind the proxy', async () => {
  const upstream = recordingUpstream(() =>
    Response.json(
      { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'skew' } },
      { status: 409, headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'protocol-mismatch' } },
    ),
  );
  const response = await tokenProxy(upstream.fetch).handle(checkedRequest(COMMAND));

  expect(response.status).toBe(409);
  expect(response.headers.get(DAEMON_HTTP_REFUSAL_HEADER)).toBe('upstream-protocol-mismatch');
});

test('a refusal header the upstream sets on /rpc never reaches the client', async () => {
  const upstream = recordingUpstream(() =>
    Response.json(
      {},
      { status: 409, headers: { [DAEMON_HTTP_REFUSAL_HEADER]: 'script-artifacts' } },
    ),
  );
  const response = await tokenProxy(upstream.fetch).handle(checkedRequest(COMMAND, {}, 'rpc'));

  expect(response.headers.get(DAEMON_HTTP_REFUSAL_HEADER)).toBeNull();
});

test.each([
  ['an unauthenticated caller', { authorization: 'Bearer wrong' }, 401, null],
  ['a skewed caller', { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: '999' }, 409, 'protocol-mismatch'],
  ['a matching caller', { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: PROTOCOL }, 400, null],
])(
  'a malformed checked body from %s is answered by auth, then protocol, then the envelope',
  async (_name, headers, status, refusal) => {
    const upstream = recordingUpstream(() => Response.json({}));
    const response = await tokenProxy(upstream.fetch).handle(
      new Request(`${PROXY_ORIGIN}/agent-device/rpc/checked`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer client-secret',
          'content-type': 'application/json',
          ...headers,
        },
        body: 'not json',
      }),
    );

    expect(response.status).toBe(status);
    expect(response.headers.get(DAEMON_HTTP_REFUSAL_HEADER)).toBe(refusal);
    expect(upstream.requests).toHaveLength(0);
  },
);

test('proxy health advertises the checked route', async () => {
  const upstream = recordingUpstream(() => Response.json({ ok: true }));
  const response = await tokenProxy(upstream.fetch).handle(
    new Request(`${PROXY_ORIGIN}/agent-device/health`),
  );

  const health = (await response.json()) as { capabilities: string[] };
  expect(health.capabilities).toEqual([DAEMON_HTTP_CHECKED_RPC_CAPABILITY]);
});
