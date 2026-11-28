// An upload ticket can carry a credential in its headers or query, so a ticket over plain http to a
// host that is not loopback is never used; the upload takes the legacy route on the daemon.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { uploadArtifact } from '../upload-client.ts';

const INSECURE_TICKET = 'http://ticket.invalid/upload/direct/t?signature=secret';

/** A daemon whose preflights answer `ticketUrls` in turn, and which resets every direct PUT. */
async function uploadAgainstTickets(ticketUrls: (origin: string) => string[]): Promise<{
  uploadId: string;
  requests: string[];
}> {
  const localPath = path.join(mkdtempForTestSync('agent-device-upload-ticket-'), 'app.apk');
  fs.writeFileSync(localPath, 'apk-bytes');
  const requests: string[] = [];
  let origin = '';
  let preflights = 0;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'PUT') return void req.socket.destroy();
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const body =
        req.url === '/upload/preflight'
          ? { upload: { url: ticketUrls(origin)[preflights++], headers: {} }, uploadId: 't' }
          : { uploadId: 'legacy-upload' };
      res.end(JSON.stringify({ ok: true, ...body }));
    });
  });
  origin = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  try {
    const uploadId = await uploadArtifact({
      localPath,
      baseUrl: origin,
      token: 'daemon-token',
      env: {},
    });
    return { uploadId, requests };
  } finally {
    await closeLoopbackServer(server);
  }
}

test('an insecure ticket is dropped unsent and the upload takes the legacy route', async () => {
  const result = await uploadAgainstTickets(() => [INSECURE_TICKET]);

  assert.equal(result.uploadId, 'legacy-upload');
  // An attempt at the ticket would fail and ask for a fresh one before the legacy upload.
  assert.deepEqual(result.requests, ['POST /upload/preflight', 'POST /upload']);
});

test('an insecure ticket from the retry preflight is dropped too', async () => {
  const result = await uploadAgainstTickets((origin) => [
    `${origin}/upload/direct/t`,
    INSECURE_TICKET,
  ]);

  assert.equal(result.uploadId, 'legacy-upload');
  assert.deepEqual(result.requests, [
    'POST /upload/preflight',
    'PUT /upload/direct/t',
    'POST /upload/preflight',
    'POST /upload',
  ]);
});
