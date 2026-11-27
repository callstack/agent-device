// The upstream daemon token never leaves the proxy in cleartext: not to a plain-http upstream off
// loopback, whatever transport carries it, and not to wherever an upstream redirect points.

import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import {
  DAEMON_HTTP_RPC_PROTOCOL_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { createDaemonProxy, type DaemonProxyUpstreamFetch } from './daemon-proxy.ts';

async function listenLocal(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function closeLocal(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => closeLocal(server)));
});

async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  return `http://127.0.0.1:${await listenLocal(server)}`;
}

const rpc = (route = 'rpc', headers: Record<string, string> = {}) =>
  new Request(`https://gateway.example.test/agent-device/${route}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent_device.command', params: {} }),
  });
const checkedRpc = () =>
  rpc('rpc/checked', { [DAEMON_HTTP_RPC_PROTOCOL_HEADER]: String(DAEMON_RPC_PROTOCOL_VERSION) });

test.each([
  ['the default transport', 'plain http off loopback', 'http://daemon.invalid:4310', undefined],
  ['a custom transport', 'plain http off loopback', 'http://daemon.invalid:4310', 'custom'],
  ['the default transport', 'a URL without a host', 'http://', undefined],
  ['a custom transport', 'a URL without a host', 'http://', 'custom'],
] as const)(
  '%s never sends the upstream token to %s',
  async (_label, _destination, upstreamBaseUrl, transport) => {
    const sent: unknown[] = [];
    for (const spy of [
      vi.spyOn(globalThis, 'fetch'),
      vi.spyOn(http, 'request'),
      vi.spyOn(https, 'request'),
    ]) {
      spy.mockImplementation((input: unknown) => {
        sent.push(input);
        throw new Error('nothing may be sent');
      });
    }
    const upstreamFetch: DaemonProxyUpstreamFetch | undefined =
      transport === 'custom'
        ? async (request) => {
            sent.push(request);
            return Response.json({});
          }
        : undefined;
    const proxy = createDaemonProxy({
      upstreamBaseUrl,
      upstreamToken: 'daemon-secret',
      clientToken: 'client-secret',
      ...(upstreamFetch ? { upstreamFetch } : {}),
    });

    for (const request of [
      rpc(),
      checkedRpc(),
      new Request('https://gateway.example.test/agent-device/health'),
      new Request('https://gateway.example.test/agent-device/artifacts/build', {
        headers: { authorization: 'Bearer client-secret' },
      }),
    ]) {
      const response = await proxy.handle(request);
      expect(response.status, request.url).toBe(400);
      expect(await response.text(), request.url).toContain('Proxy upstreamBaseUrl');
    }
    expect(sent).toEqual([]);
  },
);

test('an upstream redirect is relayed, never followed, so its target receives no token', async () => {
  const reached: string[] = [];
  const target = await serve((req, res) => {
    reached.push(`${req.method} ${req.url} ${req.headers['x-agent-device-token'] ?? ''}`);
    req.resume();
    res.end('{}');
  });
  const daemon = await serve((req, res) => {
    req.resume();
    res.statusCode = 307;
    res.setHeader('location', `${target}/redirected`);
    res.end();
  });
  // A logical https URL a transport routes internally: here, global fetch to a loopback daemon,
  // with the forwarded request's method, headers, body, and redirect mode.
  const proxy = createDaemonProxy({
    upstreamBaseUrl: 'https://daemon.example.test',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch: async (request) =>
      await fetch(`${daemon}${new URL(request.url).pathname}`, {
        method: request.method,
        headers: request.headers,
        redirect: request.redirect,
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
      }),
  });

  const health = await proxy.handle(
    new Request('https://gateway.example.test/agent-device/health'),
  );
  expect(health.status).toBe(500);
  expect((await proxy.handle(rpc())).status).toBe(307);

  expect(reached).toEqual([]);
});

test.each([
  ['a foreign origin', 'http://attacker.example/x?signature=secret', null],
  ['userinfo', 'https://user:pass@daemon.example.test/artifacts/x', null],
  ['the upstream token in its path', '/artifacts/daemon-secret', null],
  ['the percent-encoded upstream token in its path', '/artifacts/daemon%2Dsecret', null],
  ['a malformed path escape', '/artifacts/%E0%A4%A', null],
  [
    'the percent-encoded upstream token in its query',
    '/artifacts/other?token=daemon%2Dsecret',
    'https://gateway.example.test/agent-device/artifacts/other',
  ],
  [
    'the upstream token in its fragment',
    '/artifacts/other#daemon%2Dsecret',
    'https://gateway.example.test/agent-device/artifacts/other',
  ],
  [
    'the upstream daemon',
    '/artifacts/other',
    'https://gateway.example.test/agent-device/artifacts/other',
  ],
] as const)(
  'a relayed Location that names %s is relayed only on the daemon itself',
  async (_label, location, relayed) => {
    const proxy = createDaemonProxy({
      upstreamBaseUrl: 'https://daemon.example.test',
      upstreamToken: 'daemon-secret',
      clientToken: 'client-secret',
      upstreamFetch: async () => new Response(null, { status: 307, headers: { location } }),
    });

    for (const request of [
      rpc(),
      new Request('https://gateway.example.test/agent-device/artifacts/build', {
        headers: { authorization: 'Bearer client-secret' },
      }),
    ]) {
      const response = await proxy.handle(request);
      expect(response.status, request.url).toBe(307);
      expect(response.headers.get('location'), request.url).toBe(relayed);
    }
  },
);

test('the default transports relay a daemon redirect with its target on every route', async () => {
  const daemon = await serve((req, res) => {
    req.resume();
    res.statusCode = 307;
    res.setHeader('location', '/artifacts/moved');
    res.end();
  });
  const proxy = createDaemonProxy({
    upstreamBaseUrl: daemon,
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
  });

  const transfer = await proxy.handle(
    new Request('https://gateway.example.test/agent-device/artifacts/build', {
      headers: { authorization: 'Bearer client-secret' },
    }),
  );
  const command = await proxy.handle(rpc());

  expect(transfer.status).toBe(307);
  expect(transfer.headers.get('location')).toBe(
    'https://gateway.example.test/agent-device/artifacts/moved',
  );
  expect(command.status).toBe(307);
  expect(command.headers.get('location')).toBe(
    'https://gateway.example.test/agent-device/artifacts/moved',
  );
});

test.each([
  ['a 302 whose body claims health', () => Response.json({ ok: true }, { status: 302 })],
  [
    'an answer its transport reached through a redirect',
    () => Object.defineProperty(Response.json({ ok: true }), 'redirected', { value: true }),
  ],
])('an upstream health answer that is %s reports the proxy unhealthy', async (_label, answer) => {
  const proxy = createDaemonProxy({
    upstreamBaseUrl: 'https://daemon.example.test',
    upstreamToken: 'daemon-secret',
    clientToken: 'client-secret',
    upstreamFetch: async () => answer(),
  });

  const response = await proxy.handle(
    new Request('https://gateway.example.test/agent-device/health'),
  );

  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ ok: false, code: 'COMMAND_FAILED' });
});
