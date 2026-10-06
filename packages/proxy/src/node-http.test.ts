import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { expect, test } from 'vitest';
import type { DaemonProxy } from './daemon-proxy.ts';
import { createDaemonProxyRequestListener } from './node-http.ts';

async function serveThroughListener(
  socket: Socket,
  host: string,
): Promise<{ seenUrl: string | null; status: number }> {
  let seenUrl: string | null = null;
  const proxy: DaemonProxy = {
    instanceId: 'test',
    handle: async (request) => {
      seenUrl = request.url;
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
    setHeader: () => {},
    end: () => {},
  });
  const ended = new Promise<void>((resolve) => {
    res.end = () => resolve();
  });
  createDaemonProxyRequestListener(proxy)(req, res as unknown as ServerResponse);
  await ended;
  return { seenUrl, status: res.statusCode };
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
  expect(served).toEqual({ seenUrl: null, status: 400 });
});
