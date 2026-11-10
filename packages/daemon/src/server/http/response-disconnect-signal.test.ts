import http from 'node:http';
import net from 'node:net';
import { expect, test } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { isRequestCanceledError } from '@agent-device/kernel/errors';
import { responseDisconnectSignal } from './response-disconnect-signal.ts';

test.each(['request abort', 'response close', 'already aborted', 'already destroyed'] as const)(
  '%s produces a typed disconnect signal and removes its listeners',
  (event) => {
    const socket = new net.Socket();
    const req = new http.IncomingMessage(socket);
    const res = new http.ServerResponse(req);
    try {
      if (event === 'already aborted') req.destroy();
      if (event === 'already destroyed') res.destroy();
      const signal = responseDisconnectSignal(req, res);
      if (event === 'request abort') req.destroy();
      if (event === 'response close') res.emit('close');
      expect(signal.aborted).toBe(true);
      expect(isRequestCanceledError(signal.reason)).toBe(true);
      expect(req.listenerCount('aborted')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
    } finally {
      req.destroy();
      res.destroy();
      socket.destroy();
    }
  },
);

test('a completed response does not abort its disconnect signal', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let signal: AbortSignal | undefined;
  let responseClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    responseClosed = resolve;
  });
  const server = http.createServer((req, res) => {
    signal = responseDisconnectSignal(req, res);
    res.once('close', responseClosed);
    res.end('complete');
  });
  try {
    const port = await listenOnLoopback(server);
    const response = await fetch(`http://127.0.0.1:${port}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('complete');
    await closed;
    expect(signal?.aborted).toBe(false);
  } finally {
    await closeLoopbackServer(server);
  }
});
