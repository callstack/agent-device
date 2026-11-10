import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, test } from 'vitest';

import { connectCdp } from './cdp.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126, 'the fake page sends short frames only');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function readMaskedText(buffer: Buffer): { text: string; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const length = buffer[1]! & 0x7f;
  assert.ok(length < 126, 'the client sends short frames only');
  if (buffer.length < 6 + length) return null;
  const mask = buffer.subarray(2, 6);
  const payload = Buffer.from(buffer.subarray(6, 6 + length));
  for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { text: payload.toString('utf8'), rest: buffer.subarray(6 + length) };
}

/**
 * A page that, before it answers each request, sends `beforeAnswer` frames: frames an old TV
 * Chromium or a proxy in between may produce, which the session must survive.
 */
async function pageSending(beforeAnswer: readonly string[]): Promise<string> {
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('upgrade', (request: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    const accept = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (let read = readMaskedText(pending); read; read = readMaskedText(pending)) {
        pending = read.rest;
        const { id } = JSON.parse(read.text) as { id: number };
        for (const text of beforeAnswer) socket.write(textFrame(text));
        socket.write(textFrame(JSON.stringify({ id, result: { ok: true } })));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    await once(server, 'close');
  });
  return `ws://127.0.0.1:${address.port}/devtools/page/1`;
}

// PROV-9: a throw inside the WebSocket message handler is an uncaught exception, which ends the
// daemon rather than one request.
test('an unreadable frame or a failing event listener leaves the pending request answered', async () => {
  const url = await pageSending(['not json', 'null', '{"method":"Log.entryAdded","params":7}']);
  const session = await connectCdp({ title: 'page', url: 'http://tv/page/', webSocketDebuggerUrl: url });
  cleanups.push(() => session.close());
  const events: string[] = [];
  session.on(() => {
    throw new Error('listener failed');
  });
  session.on((method, params) => events.push(`${method} ${JSON.stringify(params)}`));

  assert.deepEqual(await session.send('Runtime.enable'), { ok: true });
  // The listener after a failing one still hears the event, with the malformed params dropped.
  assert.deepEqual(events, ['Log.entryAdded {}']);
});
