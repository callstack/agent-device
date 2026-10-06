import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { expect, test } from 'vitest';
import type { DaemonProxy } from './daemon-proxy.ts';
import { serveProxyRequest } from './node-http.ts';

async function serveThroughListener(
  socket: Socket,
  host: string,
  { responseClosed = false } = {},
): Promise<{ seenUrl: string | null; clientGone: boolean; status: number; ended: boolean }> {
  let seenUrl: string | null = null;
  let clientGone = false;
  let ended = false;
  const proxy: DaemonProxy = {
    instanceId: 'test',
    handle: async (request) => {
      seenUrl = request.url;
      clientGone = request.signal.aborted;
      return new Response(null, { status: 204 });
    },
  };
  const req = Object.assign(Readable.from([]), {
    method: 'GET',
    url: '/agent-device/health',
    headers: { host },
    socket,
  }) as unknown as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableFinished: false,
    destroyed: false,
    closed: responseClosed,
    setHeader: () => {},
    end: () => {
      ended = true;
    },
  });
  await serveProxyRequest(proxy, req, res as unknown as ServerResponse);
  return { seenUrl, clientGone, status: res.statusCode, ended };
}

test('requests arriving over TLS reach the proxy with an https URL', async () => {
  const served = await serveThroughListener(new TLSSocket(new Socket()), 'gateway.example.test');
  expect(served.seenUrl).toBe('https://gateway.example.test/agent-device/health');
});

test('plain requests reach the proxy with an http URL', async () => {
  const served = await serveThroughListener(new Socket(), 'gateway.example.test');
  expect(served.seenUrl).toBe('http://gateway.example.test/agent-device/health');
});

test('a Host header that cannot form a URL is answered with 400 instead of a dropped socket', async () => {
  const served = await serveThroughListener(new Socket(), 'gateway example');
  expect(served).toMatchObject({ seenUrl: null, status: 400, ended: true });
});

test('a URL carrying credentials is answered with 400 instead of a dropped socket', async () => {
  const served = await serveThroughListener(new Socket(), 'user:secret@gateway.example.test');
  expect(served).toMatchObject({ seenUrl: null, status: 400, ended: true });
});

test('a client gone before the adapter loads reaches the proxy as an aborted request', async () => {
  const served = await serveThroughListener(new Socket(), 'gateway.example.test', {
    responseClosed: true,
  });
  expect(served.clientGone).toBe(true);
});

test('a method Fetch refuses is answered with 404 instead of a dropped socket', async () => {
  const proxy: DaemonProxy = {
    instanceId: 'test',
    handle: async () => new Response(null, { status: 204 }),
  };
  const server = http.createServer((req, res) => void serveProxyRequest(proxy, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .request(
          { port, host: '127.0.0.1', method: 'TRACE', path: '/agent-device/health' },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
        .on('error', reject)
        .end();
    });
    expect(status).toBe(404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
