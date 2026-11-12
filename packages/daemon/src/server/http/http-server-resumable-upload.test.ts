import type { DaemonResponse } from '@agent-device/kernel/contracts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { test } from 'vitest';
import {
  cleanupUploadedArtifact,
  prepareUploadedArtifact,
} from '../../resources/artifact-tracking.ts';
import { createDaemonHttpServer } from './http-server.ts';
import {
  closeLoopbackServer,
  createTestRuntimeStateHandle,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';

test('chunked ranged overflow rolls back before an exact retry and finalize', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP resumable upload coverage')) return;
  const content = Buffer.from('ABCDE');
  const server = await createDaemonHttpServer({
    token: 'resumable-token',
    handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
    env: process.env,
    cwd: process.cwd(),
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

test('preflight ignores forwarding metadata and uses the socket scheme and request authority', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'daemon HTTP resumable upload coverage')) return;
  const runtime = createTestRuntimeStateHandle();
  try {
    await runtime.run(async () => {
      const server = await createDaemonHttpServer({
        token: 'resumable-token',
        handleRequest: async (): Promise<DaemonResponse> => ({ ok: true, data: {} }),
        env: process.env,
        cwd: process.cwd(),
      });
      try {
        const port = await listenOnLoopback(server);
        for (const [forwarded, authority, expectedAuthority] of [
          [undefined, undefined, undefined],
          ['https', undefined, undefined],
          ['https, http', undefined, undefined],
          ['HTTPS', undefined, undefined],
          [' hTtPs , http ', undefined, undefined],
          ['HTTP', undefined, undefined],
          ['ftp', undefined, undefined],
          ['http://evil.example/path?', undefined, undefined],
          ['HTTPS', 'Daemon.example:80', 'daemon.example'],
          ['http', 'Daemon.example:443', 'daemon.example:443'],
          ['http', 'Daemon.example:80', 'daemon.example'],
          ['https', 'Daemon.example:443', 'daemon.example:443'],
        ] as const) {
          const headers: Record<string, string> = {
            authorization: 'Bearer resumable-token',
            'content-type': 'application/json',
            'x-forwarded-host': 'evil.example:444',
            forwarded: 'host=evil.example:444;proto=https',
          };
          if (forwarded) headers['x-forwarded-proto'] = forwarded;
          if (authority) headers.host = authority;
          const body = JSON.stringify({
            uploadAttemptId: crypto.randomUUID(),
            sha256: crypto.createHash('sha256').update('a').digest('hex'),
            fileName: 'demo.apk',
            sizeBytes: 1,
            artifactType: 'file',
            platform: 'android',
          });
          const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
            const request = http.request(
              `http://127.0.0.1:${port}/upload/preflight`,
              { method: 'POST', headers },
              resolve,
            );
            request.once('error', reject);
            request.end(body);
          });
          assert.equal(response.statusCode, 200);
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(chunk);
          const ticket = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            uploadId: string;
            upload: { url: string; headers: Record<string, string> };
          };
          assert.ok(ticket.uploadId);
          const url = new URL(ticket.upload.url);
          assert.equal(url.origin, `http://${expectedAuthority ?? `127.0.0.1:${port}`}`);
          assert.match(url.pathname, /^\/upload\/direct\//);
          assert.equal(ticket.upload.headers.authorization, 'Bearer resumable-token');
        }
      } finally {
        await closeLoopbackServer(server);
      }
    });
  } finally {
    runtime.dispose();
  }
});
