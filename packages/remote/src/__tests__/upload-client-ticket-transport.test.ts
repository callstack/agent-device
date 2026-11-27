// An upload ticket can carry a credential in its headers, a cookie, or its query, so a ticket over
// plain http to a host that is not loopback is never used; the upload takes the legacy route.

import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import { uploadArtifact } from '../upload-client.ts';

async function readRequestBody(req: IncomingMessage): Promise<void> {
  for await (const _chunk of req) {
    // Drained so the response can be written.
  }
}

test('a ticket over plain http off loopback is never used, whatever carries its credential', async () => {
  const localPath = path.join(mkdtempForTestSync('agent-device-upload-ticket-'), 'app.apk');
  fs.writeFileSync(localPath, 'cleartext-ticket');
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    void readRequestBody(req).then(() => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url === '/upload/preflight'
            ? {
                ok: true,
                cacheHit: false,
                uploadId: 'cleartext-ticket',
                upload: {
                  url: 'http://ticket.invalid/upload/direct/cleartext-ticket?signature=secret',
                  headers: {},
                },
              }
            : { ok: true, uploadId: 'legacy-upload' },
        ),
      );
    });
  });
  const port = await listenOnLoopback(server);

  try {
    const uploadId = await uploadArtifact({
      localPath,
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'agent-device-upload-test-token',
      env: process.env,
    });
    // One preflight, then the legacy route: no ticket attempt, so no retry preflight either.
    assert.equal(uploadId, 'legacy-upload');
    assert.deepEqual(requests, ['POST /upload/preflight', 'POST /upload']);
  } finally {
    await closeLoopbackServer(server);
  }
});
