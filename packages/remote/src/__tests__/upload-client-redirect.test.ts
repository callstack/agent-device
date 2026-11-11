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

const CROSS_ORIGIN = 'cross-origin';

test.for([
  { leg: 'preflight', status: 307, target: '/moved' },
  { leg: 'preflight', status: 302, target: CROSS_ORIGIN },
  { leg: 'finalize', status: 302, target: '/moved' },
  { leg: 'finalize', status: 308, target: CROSS_ORIGIN },
])(
  'a $leg answered with a $status redirect to $target is not followed, and the upload goes legacy',
  async ({ leg, status, target }, t) => {
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
        if (req.url === `/upload/${leg}`) {
          res.statusCode = status;
          const foreignUrl = `${foreign.baseUrl.replace('127.0.0.1', 'localhost')}/x`;
          res.setHeader('location', target === CROSS_ORIGIN ? foreignUrl : target);
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
      assert.deepEqual(
        daemonRequests,
        leg === 'preflight'
          ? ['POST /upload/preflight', 'POST /upload']
          : [
              'POST /upload/preflight',
              'PUT /upload/direct/t',
              'POST /upload/finalize',
              'POST /upload',
            ],
      );
      assert.deepEqual(foreignRequests, []);
    } finally {
      await daemon.close();
      await foreign.close();
    }
  },
);
