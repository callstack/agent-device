import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { streamFileToHttpRequest } from '../upload-stream.ts';

async function startServer(handler: http.RequestListener): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer(handler);
  server.unref();
  const port = await listenOnLoopback(server);
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeLoopbackServer(server) };
}

test('an upload refuses a redirect to another origin and never sends it the token', async () => {
  const foreignRequests: string[] = [];
  const foreign = await startServer((req, res) => {
    foreignRequests.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ''}`);
    req.resume();
    req.on('end', () => res.end('{}'));
  });
  const origin = await startServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.statusCode = 307;
      res.setHeader('location', `${foreign.baseUrl.replace('127.0.0.1', 'localhost')}/upload`);
      res.end();
    });
  });
  const payloadPath = path.join(mkdtempForTestSync('agent-device-upload-stream-'), 'app.apk');
  fs.writeFileSync(payloadPath, 'cross-origin-payload');

  try {
    await assert.rejects(
      streamFileToHttpRequest({
        url: new URL(`${origin.baseUrl}/upload`),
        method: 'POST',
        headers: { authorization: 'Bearer daemon-token', 'transfer-encoding': 'chunked' },
        payloadPath,
        timeoutMessage: 'timed out',
        errorMessage: 'failed',
      }),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'cross-origin-redirect',
    );
    assert.deepEqual(foreignRequests, []);
  } finally {
    await origin.close();
    await foreign.close();
  }
});
