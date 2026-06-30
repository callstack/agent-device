import { test, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { uploadArtifact } from '../remote/upload-client.ts';
import type { UploadProgressEvent } from '../upload-progress.ts';
import { runCmdSync, withCommandExecutorOverride } from '../utils/exec.ts';

const TEST_TOKEN = 'agent-device-upload-test-token';
const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

test('uploadArtifact returns preflight uploadId without uploading bytes on cache hit', async () => {
  const content = 'cached-apk-payload';
  const artifactPath = createTempFile('app.apk', content);
  const expectedHash = sha256(content);
  let uploadCalled = false;

  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      assert.equal(req.headers.authorization, `Bearer ${TEST_TOKEN}`);
      assert.equal(req.headers['x-agent-device-token'], TEST_TOKEN);
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        uploadAttemptId: string;
        sha256: string;
        fileName: string;
        sizeBytes: number;
        artifactType: string;
        platform: string;
        contentType: string;
      };
      assert.equal(typeof body.uploadAttemptId, 'string');
      assert.equal(body.sha256, expectedHash);
      assert.equal(body.fileName, 'app.apk');
      assert.equal(body.sizeBytes, Buffer.byteLength(content));
      assert.equal(body.artifactType, 'file');
      assert.equal(body.platform, 'android');
      assert.equal(body.contentType, 'application/octet-stream');
      sendJson(res, { ok: true, cacheHit: true, uploadId: 'upload-cached' });
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      uploadCalled = true;
      await readRequestBody(req);
      sendJson(res, { ok: true, uploadId: 'upload-unexpected' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-cached');
    assert.equal(uploadCalled, false);
  } finally {
    await server.close();
  }
});

test('uploadArtifact uploads with hash headers after preflight cache miss', async () => {
  const content = 'fresh-apk-payload';
  const artifactPath = createTempFile('app.apk', content);
  const expectedHash = sha256(content);
  const requests: string[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        sha256: string;
      };
      assert.equal(body.sha256, expectedHash);
      sendJson(res, { ok: true, cacheHit: false });
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      assert.equal(req.headers['x-artifact-type'], 'file');
      assert.equal(req.headers['x-artifact-filename'], 'app.apk');
      assert.equal(req.headers['x-artifact-hash'], expectedHash);
      assert.equal(req.headers['x-artifact-hash-algorithm'], 'sha256');
      assert.equal(req.headers['content-type'], 'application/octet-stream');
      assert.equal((await readRequestBody(req)).toString('utf8'), content);
      sendJson(res, { ok: true, uploadId: 'upload-miss' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-miss');
    assert.deepEqual(requests, ['POST /upload/preflight', 'POST /upload']);
  } finally {
    await server.close();
  }
});

test('uploadArtifact falls back to upload when preflight is unsupported', async () => {
  const content = 'legacy-daemon-payload';
  const artifactPath = createTempFile('app.apk', content);
  const expectedHash = sha256(content);
  const requests: string[] = [];
  const progressEvents: UploadProgressEvent[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      assert.equal(req.headers['x-artifact-hash'], expectedHash);
      assert.equal(req.headers['x-artifact-hash-algorithm'], 'sha256');
      assert.equal((await readRequestBody(req)).toString('utf8'), content);
      sendJson(res, { ok: true, uploadId: 'upload-legacy' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(uploadId, 'upload-legacy');
    assert.deepEqual(requests, ['POST /upload/preflight', 'POST /upload']);
    assert.deepEqual(
      progressEvents.map((event) => event.type),
      ['start', 'progress'],
    );
    assert.deepEqual(progressEvents[0], {
      type: 'start',
      stage: 'legacy',
      fileName: 'app.apk',
      transferredBytes: 0,
      totalBytes: Buffer.byteLength(content),
    });
    assert.deepEqual(progressEvents[1], {
      type: 'progress',
      stage: 'legacy',
      fileName: 'app.apk',
      transferredBytes: Buffer.byteLength(content),
      totalBytes: Buffer.byteLength(content),
    });
  } finally {
    await server.close();
  }
});

test('uploadArtifact falls back to upload when preflight fails', async () => {
  const content = 'preflight-failure-payload';
  const artifactPath = createTempFile('app.apk', content);
  const expectedHash = sha256(content);
  const requests: string[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      res.statusCode = 503;
      res.end(JSON.stringify({ ok: false, error: 'cache temporarily unavailable' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      assert.equal(req.headers['x-artifact-hash'], expectedHash);
      assert.equal(req.headers['x-artifact-hash-algorithm'], 'sha256');
      assert.equal((await readRequestBody(req)).toString('utf8'), content);
      sendJson(res, { ok: true, uploadId: 'upload-after-preflight-failure' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-after-preflight-failure');
    assert.deepEqual(requests, ['POST /upload/preflight', 'POST /upload']);
  } finally {
    await server.close();
  }
});

test('uploadArtifact follows up to five upload redirects', async () => {
  const content = 'redirected-upload-payload';
  const artifactPath = createTempFile('app.apk', content);
  const requests: string[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      await readRequestBody(req);
      res.statusCode = 307;
      res.setHeader('location', '/upload-redirect-1');
      res.end();
      return;
    }
    const redirectMatch = req.url?.match(/^\/upload-redirect-(\d+)$/);
    if (req.method === 'POST' && redirectMatch) {
      const redirectIndex = Number(redirectMatch[1]);
      const body = (await readRequestBody(req)).toString('utf8');
      assert.equal(body, content);
      if (redirectIndex < 5) {
        res.statusCode = 307;
        res.setHeader('location', `/upload-redirect-${redirectIndex + 1}`);
        res.end();
        return;
      }
      sendJson(res, { ok: true, uploadId: 'upload-after-redirects' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-after-redirects');
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'POST /upload',
      'POST /upload-redirect-1',
      'POST /upload-redirect-2',
      'POST /upload-redirect-3',
      'POST /upload-redirect-4',
      'POST /upload-redirect-5',
    ]);
  } finally {
    await server.close();
  }
});

test('uploadArtifact fails cleanly on the sixth upload redirect', async () => {
  const content = 'too-many-redirects-upload-payload';
  const artifactPath = createTempFile('app.apk', content);
  const requests: string[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      await readRequestBody(req);
      res.statusCode = 307;
      res.setHeader('location', '/upload-redirect-1');
      res.end();
      return;
    }
    const redirectMatch = req.url?.match(/^\/upload-redirect-(\d+)$/);
    if (req.method === 'POST' && redirectMatch) {
      const redirectIndex = Number(redirectMatch[1]);
      await readRequestBody(req);
      res.statusCode = 307;
      res.setHeader('location', `/upload-redirect-${redirectIndex + 1}`);
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    await assert.rejects(
      async () =>
        await uploadArtifact({
          localPath: artifactPath,
          baseUrl: server.baseUrl,
          token: TEST_TOKEN,
        }),
      /redirect limit/i,
    );
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'POST /upload',
      'POST /upload-redirect-1',
      'POST /upload-redirect-2',
      'POST /upload-redirect-3',
      'POST /upload-redirect-4',
      'POST /upload-redirect-5',
    ]);
  } finally {
    await server.close();
  }
});

test('uploadArtifact falls back to legacy upload when direct upload exceeds redirect limit', async () => {
  const content = 'direct-upload-redirect-limit-fallback';
  const artifactPath = createTempFile('app.apk', content);
  const requests: string[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      sendJson(res, {
        ok: true,
        cacheHit: false,
        uploadId: 'direct-redirect-ticket',
        upload: {
          url: `${server.baseUrl}/direct-redirect-1`,
          headers: {
            'x-signed-ticket': 'redirect-ticket-header',
          },
        },
      });
      return;
    }
    const redirectMatch = req.url?.match(/^\/direct-redirect-(\d+)$/);
    if (req.method === 'PUT' && redirectMatch) {
      const redirectIndex = Number(redirectMatch[1]);
      await readRequestBody(req);
      res.statusCode = 307;
      res.setHeader('location', `/direct-redirect-${redirectIndex + 1}`);
      res.end();
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      assert.equal((await readRequestBody(req)).toString('utf8'), content);
      sendJson(res, { ok: true, uploadId: 'legacy-after-direct-redirect-limit' });
      return;
    }
    if (req.method === 'POST' && req.url === '/upload/finalize') {
      res.statusCode = 500;
      res.end('direct upload should not finalize after redirect-limit fallback');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'legacy-after-direct-redirect-limit');
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'PUT /direct-redirect-1',
      'PUT /direct-redirect-2',
      'PUT /direct-redirect-3',
      'PUT /direct-redirect-4',
      'PUT /direct-redirect-5',
      'PUT /direct-redirect-6',
      'POST /upload',
    ]);
  } finally {
    await server.close();
  }
});

test('uploadArtifact uses direct upload ticket and finalize flow', async () => {
  const content = 'direct-upload-apk';
  const artifactPath = createTempFile('app.apk', content);
  const expectedHash = sha256(content);
  const requests: string[] = [];
  let directUploadBody = '';
  const progressEvents: UploadProgressEvent[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        uploadAttemptId: string;
        sha256: string;
        fileName: string;
        artifactType: string;
        platform: string;
        contentType: string;
      };
      assert.equal(typeof body.uploadAttemptId, 'string');
      assert.equal(body.sha256, expectedHash);
      assert.equal(body.fileName, 'app.apk');
      assert.equal(body.artifactType, 'file');
      assert.equal(body.platform, 'android');
      assert.equal(body.contentType, 'application/octet-stream');
      sendJson(res, {
        ok: true,
        cacheHit: false,
        uploadId: 'direct-ticket',
        upload: {
          url: `${server.baseUrl}/signed-upload`,
          headers: {
            'x-signed-ticket': 'ticket-header',
          },
        },
      });
      return;
    }
    if (req.method === 'PUT' && req.url === '/signed-upload') {
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.headers['x-agent-device-token'], undefined);
      assert.equal(req.headers['x-signed-ticket'], 'ticket-header');
      directUploadBody = (await readRequestBody(req)).toString('utf8');
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload/finalize') {
      assert.equal(req.headers.authorization, `Bearer ${TEST_TOKEN}`);
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        uploadId: string;
      };
      assert.equal(body.uploadId, 'direct-ticket');
      sendJson(res, { ok: true, uploadId: 'upload-finalized' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(uploadId, 'upload-finalized');
    assert.equal(directUploadBody, content);
    assert.deepEqual(
      progressEvents.map((event) => event.type),
      ['start', 'progress'],
    );
    assert.deepEqual(progressEvents[0], {
      type: 'start',
      stage: 'direct',
      fileName: 'app.apk',
      transferredBytes: 0,
      totalBytes: Buffer.byteLength(content),
    });
    assert.deepEqual(progressEvents[1], {
      type: 'progress',
      stage: 'direct',
      fileName: 'app.apk',
      transferredBytes: Buffer.byteLength(content),
      totalBytes: Buffer.byteLength(content),
    });
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'PUT /signed-upload',
      'POST /upload/finalize',
    ]);
  } finally {
    await server.close();
  }
});

test.each([
  {
    name: 'x-upload-offset',
    writeResumeHeaders: (res: ServerResponse, payloadSize: number) => {
      res.setHeader('x-upload-offset', String(payloadSize));
    },
  },
  {
    name: 'range',
    writeResumeHeaders: (res: ServerResponse, payloadSize: number) => {
      res.setHeader('range', `bytes=0-${payloadSize - 1}`);
    },
  },
])(
  'uploadArtifact finalizes when direct upload reports the full payload size with $name',
  async ({ writeResumeHeaders }) => {
    const content = 'direct-upload-already-complete';
    const artifactPath = createTempFile('app.apk', content);
    const payloadSize = Buffer.byteLength(content);
    const requests: string[] = [];
    let uploadAttempts = 0;

    const server = await startServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/upload/preflight') {
        await readRequestBody(req);
        sendJson(res, {
          ok: true,
          cacheHit: false,
          uploadId: 'complete-resume-ticket',
          upload: {
            url: `${server.baseUrl}/already-complete-upload`,
            headers: {
              'x-signed-ticket': 'complete-ticket-header',
            },
          },
        });
        return;
      }
      if (req.method === 'PUT' && req.url === '/already-complete-upload') {
        uploadAttempts += 1;
        assert.equal(req.headers['content-range'], undefined);
        assert.equal((await readRequestBody(req)).toString('utf8'), content);
        res.statusCode = 308;
        writeResumeHeaders(res, payloadSize);
        res.end();
        return;
      }
      if (req.method === 'POST' && req.url === '/upload/finalize') {
        const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
          uploadId: string;
        };
        assert.equal(body.uploadId, 'complete-resume-ticket');
        sendJson(res, { ok: true, uploadId: 'upload-already-complete' });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    try {
      const uploadId = await uploadArtifact({
        localPath: artifactPath,
        baseUrl: server.baseUrl,
        token: TEST_TOKEN,
      });
      assert.equal(uploadId, 'upload-already-complete');
      assert.equal(uploadAttempts, 1);
      assert.deepEqual(requests, [
        'POST /upload/preflight',
        'PUT /already-complete-upload',
        'POST /upload/finalize',
      ]);
    } finally {
      await server.close();
    }
  },
);

test('uploadArtifact resumes a direct upload from the server-reported offset', async () => {
  const content = 'direct-upload-resume-payload';
  const artifactPath = createTempFile('app.apk', content);
  const resumeOffset = 7;
  const requests: string[] = [];
  let uploadAttempts = 0;
  let firstUploadBody = '';
  let resumedUploadBody = '';
  const progressEvents: UploadProgressEvent[] = [];

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      await readRequestBody(req);
      sendJson(res, {
        ok: true,
        cacheHit: false,
        uploadId: 'resume-ticket',
        upload: {
          url: `${server.baseUrl}/resumable-upload`,
          headers: {
            'x-signed-ticket': 'resume-ticket-header',
          },
        },
      });
      return;
    }
    if (req.method === 'PUT' && req.url === '/resumable-upload') {
      uploadAttempts += 1;
      if (uploadAttempts === 1) {
        assert.equal(req.headers['content-range'], undefined);
        firstUploadBody = (await readRequestBody(req)).toString('utf8');
        res.statusCode = 308;
        res.setHeader('range', `bytes=0-${resumeOffset - 1}`);
        res.end();
        return;
      }

      assert.equal(
        req.headers['content-range'],
        `bytes ${resumeOffset}-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}`,
      );
      assert.equal(
        req.headers['content-length'],
        String(Buffer.byteLength(content) - resumeOffset),
      );
      resumedUploadBody = (await readRequestBody(req)).toString('utf8');
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload/finalize') {
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        uploadId: string;
      };
      assert.equal(body.uploadId, 'resume-ticket');
      sendJson(res, { ok: true, uploadId: 'upload-resumed' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
      onProgress: (event) => progressEvents.push(event),
    });
    assert.equal(uploadId, 'upload-resumed');
    assert.equal(firstUploadBody, content);
    assert.equal(resumedUploadBody, content.slice(resumeOffset));
    assert.deepEqual(
      progressEvents.map((event) => event.type),
      ['start', 'progress', 'resume', 'progress'],
    );
    assert.deepEqual(progressEvents[0], {
      type: 'start',
      stage: 'direct',
      fileName: 'app.apk',
      transferredBytes: 0,
      totalBytes: Buffer.byteLength(content),
    });
    assert.deepEqual(progressEvents[2], {
      type: 'resume',
      stage: 'direct',
      fileName: 'app.apk',
      transferredBytes: resumeOffset,
      totalBytes: Buffer.byteLength(content),
    });
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'PUT /resumable-upload',
      'PUT /resumable-upload',
      'POST /upload/finalize',
    ]);
  } finally {
    await server.close();
  }
});

test('uploadArtifact re-preflights and resumes after an interrupted direct upload', async () => {
  const content = 'direct-upload-interrupted-payload';
  const artifactPath = createTempFile('app.apk', content);
  const resumeOffset = 8;
  const requests: string[] = [];
  let preflightAttempts = 0;
  const uploadAttemptIds: string[] = [];
  let uploadAttempts = 0;
  let resumedUploadBody = '';

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      preflightAttempts += 1;
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        uploadAttemptId: string;
      };
      uploadAttemptIds.push(body.uploadAttemptId);
      sendJson(res, {
        ok: true,
        cacheHit: false,
        uploadId: 'resume-after-error-ticket',
        upload: {
          url: `${server.baseUrl}/resumable-upload-after-error`,
          headers: {
            'x-signed-ticket': 'resume-after-error-ticket-header',
          },
        },
      });
      return;
    }
    if (req.method === 'PUT' && req.url === '/resumable-upload-after-error') {
      uploadAttempts += 1;
      if (uploadAttempts === 1) {
        req.destroy(new Error('simulated low-connectivity interruption'));
        return;
      }
      if (uploadAttempts === 2) {
        assert.equal(req.headers['content-range'], undefined);
        res.statusCode = 308;
        res.setHeader('x-upload-offset', String(resumeOffset));
        res.end();
        return;
      }

      assert.equal(
        req.headers['content-range'],
        `bytes ${resumeOffset}-${Buffer.byteLength(content) - 1}/${Buffer.byteLength(content)}`,
      );
      resumedUploadBody = (await readRequestBody(req)).toString('utf8');
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    if (req.method === 'POST' && req.url === '/upload/finalize') {
      sendJson(res, { ok: true, uploadId: 'upload-resumed-after-error' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: artifactPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-resumed-after-error');
    assert.equal(preflightAttempts, 2);
    assert.equal(uploadAttemptIds.length, 2);
    assert.equal(typeof uploadAttemptIds[0], 'string');
    assert.equal(uploadAttemptIds[0], uploadAttemptIds[1]);
    assert.equal(resumedUploadBody, content.slice(resumeOffset));
    assert.deepEqual(requests, [
      'POST /upload/preflight',
      'PUT /resumable-upload-after-error',
      'POST /upload/preflight',
      'PUT /resumable-upload-after-error',
      'PUT /resumable-upload-after-error',
      'POST /upload/finalize',
    ]);
  } finally {
    await server.close();
  }
});

test('uploadArtifact preflights and legacy-uploads compressed app bundle directories', async () => {
  const tempRoot = createTempDir();
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'payload.txt'), 'app-bundle-payload');
  const requests: string[] = [];
  let preflightSha = '';
  let preflightSize = 0;

  const server = await startServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        sha256: string;
        fileName: string;
        sizeBytes: number;
        artifactType: string;
        platform: string;
        contentType: string;
      };
      preflightSha = body.sha256;
      preflightSize = body.sizeBytes;
      assert.equal(body.fileName, 'Sample.app');
      assert.equal(body.artifactType, 'app-bundle');
      assert.equal(body.platform, 'ios');
      assert.equal(body.contentType, 'application/gzip');
      sendJson(res, { ok: true, cacheHit: false });
      return;
    }
    if (req.method === 'POST' && req.url === '/upload') {
      assert.equal(req.headers['x-artifact-type'], 'app-bundle');
      assert.equal(req.headers['x-artifact-filename'], 'Sample.app');
      assert.equal(req.headers['x-artifact-hash'], preflightSha);
      assert.equal(req.headers['x-artifact-hash-algorithm'], 'sha256');
      assert.equal(req.headers['content-type'], 'application/gzip');
      const body = await readRequestBody(req);
      assert.equal(body.length, preflightSize);
      assert.equal(sha256(body), preflightSha);
      assert.ok(body.length > 0);
      assert.deepEqual(listTarGzipEntries(body), ['Sample.app/', 'Sample.app/payload.txt']);
      sendJson(res, { ok: true, uploadId: 'upload-app-bundle' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await uploadArtifact({
      localPath: appPath,
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
    });
    assert.equal(uploadId, 'upload-app-bundle');
    assert.deepEqual(requests, ['POST /upload/preflight', 'POST /upload']);
  } finally {
    await server.close();
  }
});

test('uploadArtifact disables macOS AppleDouble entries when archiving app bundles', async () => {
  const tempRoot = createTempDir();
  const appPath = path.join(tempRoot, 'Sample.app');
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(path.join(appPath, 'Info.plist'), 'fake-plist');
  let tarEnv: NodeJS.ProcessEnv | undefined;

  const server = await startServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/upload/preflight') {
      const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
        fileName: string;
        artifactType: string;
      };
      assert.equal(body.fileName, 'Sample.app');
      assert.equal(body.artifactType, 'app-bundle');
      sendJson(res, { ok: true, cacheHit: true, uploadId: 'upload-cached-app' });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  try {
    const uploadId = await withCommandExecutorOverride(
      (cmd, args, options) => {
        if (cmd !== 'tar') return undefined;
        tarEnv = options.env;
        const archivePath = args[1]!;
        assert.equal(args[0], 'czf');
        assert.equal(typeof archivePath, 'string');
        fs.writeFileSync(archivePath, 'fake-archive');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
      },
      async () =>
        await uploadArtifact({
          localPath: appPath,
          baseUrl: server.baseUrl,
          token: TEST_TOKEN,
        }),
    );
    assert.equal(uploadId, 'upload-cached-app');
    assert.equal(tarEnv?.COPYFILE_DISABLE, '1');
  } finally {
    await server.close();
  }
});

test('uploadArtifact uploads APK, AAB, and IPA files without wrapping them', async () => {
  const cases = [
    { filename: 'app.apk', platform: 'android' },
    { filename: 'app.aab', platform: 'android' },
    { filename: 'App.ipa', platform: 'ios' },
  ] as const;

  for (const testCase of cases) {
    const content = `${testCase.filename}-payload`;
    const artifactPath = createTempFile(testCase.filename, content);
    const requests: string[] = [];

    const server = await startServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && req.url === '/upload/preflight') {
        const body = JSON.parse((await readRequestBody(req)).toString('utf8')) as {
          fileName: string;
          artifactType: string;
          platform: string;
          contentType: string;
        };
        assert.equal(body.fileName, testCase.filename);
        assert.equal(body.artifactType, 'file');
        assert.equal(body.platform, testCase.platform);
        assert.equal(body.contentType, 'application/octet-stream');
        sendJson(res, { ok: true, cacheHit: false });
        return;
      }
      if (req.method === 'POST' && req.url === '/upload') {
        assert.equal(req.headers['x-artifact-type'], 'file');
        assert.equal(req.headers['x-artifact-filename'], testCase.filename);
        assert.equal((await readRequestBody(req)).toString('utf8'), content);
        sendJson(res, { ok: true, uploadId: `upload-${testCase.platform}` });
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });

    try {
      await uploadArtifact({
        localPath: artifactPath,
        baseUrl: server.baseUrl,
        token: TEST_TOKEN,
      });
      assert.deepEqual(requests, ['POST /upload/preflight', 'POST /upload']);
    } finally {
      await server.close();
    }
  }
});

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agent-device-upload-client-${randomUUID()}-`));
  tempDirs.push(dir);
  return dir;
}

function createTempFile(filename: string, content: string): string {
  const dir = createTempDir();
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function listTarGzipEntries(archive: Buffer): string[] {
  const dir = createTempDir();
  const archivePath = path.join(dir, 'archive.tar.gz');
  fs.writeFileSync(archivePath, archive);
  const result = runCmdSync('tar', ['-tzf', archivePath]);
  return result.stdout
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  server.unref();
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
