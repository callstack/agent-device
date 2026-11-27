// The upstream daemon token never leaves the proxy in cleartext: not to a plain-http upstream off
// loopback, whatever transport carries it, and not to wherever an upstream redirect points.

import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
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

const rpc = () =>
  new Request('https://gateway.example.test/agent-device/rpc', {
    method: 'POST',
    headers: { authorization: 'Bearer client-secret', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'agent-device.command', params: {} }),
  });

test.each([
  ['the default transport', undefined],
  ['a custom transport', 'custom'],
] as const)(
  '%s never sends the upstream token to plain http off loopback',
  async (_label, transport) => {
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
      upstreamBaseUrl: 'http://daemon.invalid:4310',
      upstreamToken: 'daemon-secret',
      clientToken: 'client-secret',
      ...(upstreamFetch ? { upstreamFetch } : {}),
    });

    for (const request of [
      rpc(),
      new Request('https://gateway.example.test/agent-device/health'),
      new Request('https://gateway.example.test/agent-device/artifacts/build', {
        headers: { authorization: 'Bearer client-secret' },
      }),
    ]) {
      const response = await proxy.handle(request);
      expect(response.status, request.url).toBe(400);
      expect(await response.text(), request.url).toContain(
        'plain http is allowed only on loopback',
      );
    }
    expect(sent).toEqual([]);
  },
);

test('an upstream redirect is never followed, so its target receives no token', async () => {
  const reached: string[] = [];
  const target = await serve((req, res) => {
    reached.push(`${req.method} ${req.url} ${req.headers['x-agent-device-token'] ?? ''}`);
    req.resume();
    res.end('{}');
  });
  const daemon = await serve((req, res) => {
    req.resume();
    res.statusCode = 307;
    res.setHeader('location', `${target}${req.url}`);
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

  await (
    await proxy.handle(new Request('https://gateway.example.test/agent-device/health'))
  ).text();
  expect((await proxy.handle(rpc())).status).toBeGreaterThanOrEqual(400);

  expect(reached).toEqual([]);
});
