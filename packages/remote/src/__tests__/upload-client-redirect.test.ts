// A direct-upload ticket whose PUT redirects to another origin must not reach that origin, and the
// upload must still finish through the legacy route on the daemon itself.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { uploadArtifact } from '../upload-client.ts';

async function startServer(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.unref();
  const port = await listenOnLoopback(server);
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => closeLoopbackServer(server) };
}

function answerJson(res: http.ServerResponse, body: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

test.for([307, 308])(
  'a direct upload redirected cross-origin with %i falls back to the legacy route',
  async (status, t) => {
    if (await skipWhenLoopbackUnavailable(t, 'upload redirect coverage')) return;
    const foreignRequests: string[] = [];
    const foreign = await startServer((req, res) => {
      foreignRequests.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => res.end());
    });
    const daemonRequests: string[] = [];
    const daemon = await startServer((req, res) => {
      daemonRequests.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        if (req.url === '/upload/preflight') {
          const url = `${daemon.baseUrl}/upload/direct/t`;
          return answerJson(res, { ok: true, uploadId: 't', upload: { url, headers: {} } });
        }
        if (req.url === '/upload/direct/t') {
          res.statusCode = status;
          res.setHeader('location', `${foreign.baseUrl.replace('127.0.0.1', 'localhost')}/x`);
          return res.end();
        }
        answerJson(res, { ok: true, uploadId: 'legacy-upload' });
      });
    });
    const localPath = path.join(mkdtempForTestSync('agent-device-upload-redirect-'), 'app.apk');
    fs.writeFileSync(localPath, 'apk-bytes');

    try {
      const uploadId = await uploadArtifact({
        localPath,
        baseUrl: daemon.baseUrl,
        token: 'daemon-token',
        env: process.env,
      });
      assert.equal(uploadId, 'legacy-upload');
      assert.deepEqual(daemonRequests, [
        'POST /upload/preflight',
        'PUT /upload/direct/t',
        'POST /upload',
      ]);
      assert.deepEqual(foreignRequests, []);
    } finally {
      await daemon.close();
      await foreign.close();
    }
  },
);

test.for([
  {
    leg: 'preflight',
    status: 307,
    redirected: '/upload/preflight',
    routes: ['POST /upload/preflight', 'POST /upload'],
  },
  {
    leg: 'preflight',
    status: 302,
    redirected: '/upload/preflight',
    routes: ['POST /upload/preflight', 'POST /upload'],
  },
  {
    leg: 'finalize',
    status: 307,
    redirected: '/upload/finalize',
    routes: [
      'POST /upload/preflight',
      'PUT /upload/direct/t',
      'POST /upload/finalize',
      'POST /upload',
    ],
  },
])(
  'a credentialed $leg redirected cross-origin with $status never reaches that origin',
  async ({ status, redirected, routes }, t) => {
    if (await skipWhenLoopbackUnavailable(t, 'upload redirect coverage')) return;
    const foreignRequests: string[] = [];
    const foreign = await startServer((req, res) => {
      foreignRequests.push(`${req.method} ${req.url} token=${req.headers['x-agent-device-token']}`);
      req.resume();
      req.on('end', () => res.end('{}'));
    });
    const daemonRequests: string[] = [];
    const daemon = await startServer((req, res) => {
      daemonRequests.push(`${req.method} ${req.url}`);
      req.resume();
      req.on('end', () => {
        if (req.url === redirected) {
          res.statusCode = status;
          res.setHeader('location', `${foreign.baseUrl.replace('127.0.0.1', 'localhost')}/x`);
          return res.end();
        }
        if (req.url === '/upload/preflight') {
          const url = `${daemon.baseUrl}/upload/direct/t`;
          return answerJson(res, { ok: true, uploadId: 't', upload: { url, headers: {} } });
        }
        answerJson(res, { ok: true, uploadId: 'legacy-upload' });
      });
    });
    const localPath = path.join(mkdtempForTestSync('agent-device-upload-redirect-'), 'app.apk');
    fs.writeFileSync(localPath, 'apk-bytes');

    try {
      const uploadId = await uploadArtifact({
        localPath,
        baseUrl: daemon.baseUrl,
        token: 'daemon-token',
        env: process.env,
      });
      assert.equal(uploadId, 'legacy-upload');
      assert.deepEqual(daemonRequests, routes);
      assert.deepEqual(foreignRequests, []);
    } finally {
      await daemon.close();
      await foreign.close();
    }
  },
);

test('a credentialed preflight follows a same-origin 302 as a GET that keeps its credentials', async (t) => {
  if (await skipWhenLoopbackUnavailable(t, 'upload redirect coverage')) return;
  const daemonRequests: string[] = [];
  const daemon = await startServer((req, res) => {
    daemonRequests.push(`${req.method} ${req.url} token=${req.headers['x-agent-device-token']}`);
    req.resume();
    req.on('end', () => {
      if (req.url === '/upload/preflight') {
        res.statusCode = 302;
        res.setHeader('location', '/upload/preflight-moved');
        return res.end('moved');
      }
      answerJson(res, { ok: true, uploadId: 'cached-upload', cacheHit: true });
    });
  });
  const localPath = path.join(mkdtempForTestSync('agent-device-upload-redirect-'), 'app.apk');
  fs.writeFileSync(localPath, 'apk-bytes');

  try {
    const uploadId = await uploadArtifact({
      localPath,
      baseUrl: daemon.baseUrl,
      token: 'daemon-token',
      env: process.env,
    });
    assert.equal(uploadId, 'cached-upload');
    assert.deepEqual(daemonRequests, [
      'POST /upload/preflight token=daemon-token',
      'GET /upload/preflight-moved token=daemon-token',
    ]);
  } finally {
    await daemon.close();
  }
});
