import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'vitest';
import {
  cleanupUploadedArtifact,
  prepareUploadedArtifact,
} from '../../../src/daemon/artifact-tracking.ts';
import { createDaemonHttpServer } from '../../../src/daemon/server/http-server.ts';
import type { DaemonResponse } from '../../../src/daemon/types.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../src/__tests__/test-utils/loopback.ts';

test('chunked ranged overflow rolls back before an exact retry and finalize', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP resumable upload coverage')) return;
  const content = Buffer.from('ABCDE');
  const server = await createDaemonHttpServer({
    token: 'resumable-token',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
  });
  let trackedUploadId = '';
  try {
    const port = await listenOnLoopback(server);
    const auth = { authorization: 'Bearer resumable-token' };
    const preflight = await fetch(`http://127.0.0.1:${port}/upload/preflight`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        uploadAttemptId: crypto.randomUUID(),
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
        fileName: 'demo.apk',
        sizeBytes: content.length,
        artifactType: 'file',
        platform: 'android',
      }),
    });
    const ticket = (await preflight.json()) as {
      uploadId?: string;
      upload?: { url?: string; headers?: Record<string, string> };
    };
    assert.ok(ticket.uploadId && ticket.upload?.url);
    const uploadHeaders = ticket.upload.headers ?? {};

    const rejected = await chunkedPut(
      ticket.upload.url,
      {
        ...uploadHeaders,
        'content-range': 'bytes 0-1/5',
      },
      Buffer.from('ABC'),
    );
    assert.ok(rejected >= 400);
    const retried = await fetch(ticket.upload.url, {
      method: 'PUT',
      headers: { ...uploadHeaders, 'content-range': 'bytes 0-1/5' },
      body: Buffer.from('AB'),
    });
    assert.equal(retried.status, 308);
    assert.equal(retried.headers.get('x-upload-offset'), '2');
    const completed = await fetch(ticket.upload.url, {
      method: 'PUT',
      headers: { ...uploadHeaders, 'content-range': 'bytes 2-4/5' },
      body: Buffer.from('CDE'),
    });
    assert.equal(completed.status, 200);

    const finalized = await fetch(`http://127.0.0.1:${port}/upload/finalize`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ uploadId: ticket.uploadId }),
    });
    assert.equal(finalized.status, 200);
    const body = (await finalized.json()) as { uploadId?: string };
    trackedUploadId = body.uploadId ?? '';
    assert.deepEqual(fs.readFileSync(prepareUploadedArtifact(trackedUploadId)), content);
  } finally {
    if (trackedUploadId) cleanupUploadedArtifact(trackedUploadId);
    await closeLoopbackServer(server);
  }
});

function chunkedPut(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT', headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    req.once('error', reject);
    req.write(body);
    req.end();
  });
}
