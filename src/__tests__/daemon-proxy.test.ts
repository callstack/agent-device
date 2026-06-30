import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createDaemonProxyServer } from '../remote/daemon-proxy.ts';
import { DAEMON_RPC_PROTOCOL_VERSION } from '../daemon/http-health.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from './test-utils/index.ts';

test('daemon proxy forwards rpc requests with upstream daemon token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let upstreamAuth = '';
  let upstreamTokenHeader = '';
  let upstreamBody: Record<string, any> | undefined;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    assert.equal(req.url, '/rpc');
    upstreamAuth = String(req.headers.authorization ?? '');
    upstreamTokenHeader = String(req.headers['x-agent-device-token'] ?? '');
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      upstreamBody = JSON.parse(body) as Record<string, any>;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: upstreamBody.id,
          result: { ok: true, data: { via: 'proxy' } },
        }),
      );
    });
  });

  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'daemon-secret',
    clientToken: 'proxy-secret',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer proxy-secret',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'agent_device.command',
        params: {
          token: 'proxy-secret',
          session: 'default',
          command: 'devices',
          positionals: [],
          flags: {},
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      jsonrpc: '2.0',
      id: 'req-1',
      result: { ok: true, data: { via: 'proxy' } },
    });
    assert.equal(upstreamAuth, 'Bearer daemon-secret');
    assert.equal(upstreamTokenHeader, 'daemon-secret');
    assert.equal(upstreamBody?.params?.token, 'daemon-secret');
    assert.equal(upstreamBody?.params?.command, 'devices');
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

test('daemon proxy rejects unauthenticated rpc requests', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let upstreamCalled = false;
  const upstream = http.createServer((_req, res) => {
    upstreamCalled = true;
    res.end('{}');
  });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'daemon-secret',
    clientToken: 'proxy-secret',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'req-unauthorized',
        method: 'agent_device.command',
        params: { command: 'devices' },
      }),
    });

    assert.equal(response.status, 401);
    const payload = (await response.json()) as { error?: { message?: string } };
    assert.equal(payload.error?.message, 'Invalid proxy token');
    assert.equal(upstreamCalled, false);
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

test('daemon proxy leaves health endpoint unauthenticated', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let upstreamAuth = '';
  let upstreamTokenHeader = '';
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/health');
    upstreamAuth = String(req.headers.authorization ?? '');
    upstreamTokenHeader = String(req.headers['x-agent-device-token'] ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'daemon-secret',
    clientToken: 'proxy-secret',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/health`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as Record<string, any>;
    assert.equal(payload.ok, true);
    assert.equal(payload.service, 'agent-device-proxy');
    assert.equal(typeof payload.version, 'string');
    assert.equal(payload.rpcProtocolVersion, DAEMON_RPC_PROTOCOL_VERSION);
    assert.deepEqual(payload.upstream, { ok: true });
    assert.equal(upstreamAuth, 'Bearer daemon-secret');
    assert.equal(upstreamTokenHeader, 'daemon-secret');
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

test('daemon proxy streams uploads and artifact downloads with upstream daemon token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let uploadAuth = '';
  let uploadTokenHeader = '';
  let uploadArtifactType = '';
  let uploadArtifactFilename = '';
  let uploadBody = '';
  let artifactAuth = '';
  let artifactTokenHeader = '';
  const upstream = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/upload') {
      uploadAuth = String(req.headers.authorization ?? '');
      uploadTokenHeader = String(req.headers['x-agent-device-token'] ?? '');
      uploadArtifactType = String(req.headers['x-artifact-type'] ?? '');
      uploadArtifactFilename = String(req.headers['x-artifact-filename'] ?? '');
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        uploadBody += chunk;
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, uploadId: 'upload-1' }));
      });
      return;
    }

    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/artifacts/shot-1?download=1');
    artifactAuth = String(req.headers.authorization ?? '');
    artifactTokenHeader = String(req.headers['x-agent-device-token'] ?? '');
    res.setHeader('content-type', 'image/png');
    res.setHeader('content-disposition', 'attachment; filename="shot.png"');
    res.setHeader('x-request-id', 'upstream-request-1');
    res.write('png-');
    res.end('body');
  });
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'daemon-secret',
    clientToken: 'proxy-secret',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const upload = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer proxy-secret',
        'x-artifact-type': 'file',
        'x-artifact-filename': 'demo.apk',
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from('fake-apk'),
    });
    assert.equal(upload.status, 200);
    assert.deepEqual(await upload.json(), { ok: true, uploadId: 'upload-1' });
    assert.equal(uploadAuth, 'Bearer daemon-secret');
    assert.equal(uploadTokenHeader, 'daemon-secret');
    assert.equal(uploadArtifactType, 'file');
    assert.equal(uploadArtifactFilename, 'demo.apk');
    assert.equal(uploadBody, 'fake-apk');

    const artifact = await fetch(
      `http://127.0.0.1:${proxyPort}/agent-device/artifacts/shot-1?download=1`,
      { headers: { authorization: 'Bearer proxy-secret' } },
    );
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'png-body');
    assert.equal(artifact.headers.get('content-type'), 'image/png');
    assert.match(artifact.headers.get('content-disposition') ?? '', /shot\.png/);
    assert.equal(artifact.headers.get('x-request-id'), 'upstream-request-1');
    assert.equal(artifactAuth, 'Bearer daemon-secret');
    assert.equal(artifactTokenHeader, 'daemon-secret');
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

test('daemon proxy forwards resumable upload routes and rewrites direct upload tickets', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const capture: ResumableUploadProxyCapture = {};
  const upstream = createResumableUploadProxyUpstream(capture);
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${await listenOnLoopback(upstream)}`,
    upstreamToken: 'daemon-secret',
    clientToken: 'proxy-secret',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const ticket = await requestRewrittenUploadTicket(proxyPort);
    await assertDirectUploadUsesDaemonToken(ticket, capture);
    await assertFinalizeUsesDaemonToken(proxyPort, capture);
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

type RewrittenUploadTicket = {
  url: string;
  headers: Record<string, string>;
};

type ResumableUploadProxyCapture = {
  direct?: {
    auth: string;
    token: string;
    contentRange: string;
    body: string;
  };
  finalizeAuth?: string;
};

async function requestRewrittenUploadTicket(proxyPort: number): Promise<RewrittenUploadTicket> {
  const preflight = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/upload/preflight`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      uploadAttemptId: 'proxy-resumable-upload-test',
      sha256: crypto.createHash('sha256').update('resumed').digest('hex'),
      fileName: 'demo.apk',
      sizeBytes: 7,
      artifactType: 'file',
    }),
  });
  assert.equal(preflight.status, 200);

  const body = (await preflight.json()) as {
    upload?: { url?: string; headers?: Record<string, string> };
  };
  const ticket = readUploadTicket(body);
  assert.match(
    ticket.url,
    new RegExp(`^http://127\\.0\\.0\\.1:${proxyPort}/agent-device/upload/direct/upload-1$`),
  );
  assert.equal(ticket.headers.authorization, 'Bearer proxy-secret');
  assert.equal(ticket.headers['x-agent-device-token'], 'proxy-secret');
  return ticket;
}

function readUploadTicket(body: {
  upload?: { url?: string; headers?: Record<string, string> };
}): RewrittenUploadTicket {
  if (!body.upload?.url) throw new Error('missing upload url');
  return {
    url: body.upload.url,
    headers: body.upload.headers ?? {},
  };
}

async function assertDirectUploadUsesDaemonToken(
  ticket: RewrittenUploadTicket,
  capture: ResumableUploadProxyCapture,
): Promise<void> {
  const direct = await fetch(ticket.url, {
    method: 'PUT',
    headers: {
      ...ticket.headers,
      'content-range': 'bytes 3-6/7',
    },
    body: Buffer.from('umed'),
  });
  assert.equal(direct.status, 200);
  assert.deepEqual(capture.direct, {
    auth: 'Bearer daemon-secret',
    token: 'daemon-secret',
    contentRange: 'bytes 3-6/7',
    body: 'umed',
  });
}

async function assertFinalizeUsesDaemonToken(
  proxyPort: number,
  capture: ResumableUploadProxyCapture,
): Promise<void> {
  const finalize = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/upload/finalize`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer proxy-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ uploadId: 'upload-1' }),
  });
  assert.equal(finalize.status, 200);
  assert.deepEqual(await finalize.json(), { ok: true, uploadId: 'tracked-upload-1' });
  assert.equal(capture.finalizeAuth, 'Bearer daemon-secret');
}

function createResumableUploadProxyUpstream(capture: ResumableUploadProxyCapture): http.Server {
  return http.createServer((req, res) => {
    const route = `${req.method ?? ''} ${req.url ?? ''}`;
    switch (route) {
      case 'GET /health':
        sendUploadProxyHealth(res);
        return;
      case 'POST /upload/preflight':
        sendUploadProxyPreflight(res);
        return;
      case 'PUT /upload/direct/upload-1':
        captureUploadProxyDirectRequest(req, res, capture);
        return;
      case 'POST /upload/finalize':
        sendUploadProxyFinalize(req, res, capture);
        return;
      default:
        res.statusCode = 404;
        res.end('not found');
    }
  });
}

function sendUploadProxyHealth(res: http.ServerResponse): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
}

function sendUploadProxyPreflight(res: http.ServerResponse): void {
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      ok: true,
      cacheHit: false,
      uploadId: 'upload-1',
      upload: {
        url: 'http://127.0.0.1:65535/upload/direct/upload-1',
        headers: {
          authorization: 'Bearer daemon-secret',
          'x-agent-device-token': 'daemon-secret',
          'content-type': 'application/octet-stream',
        },
      },
    }),
  );
}

function captureUploadProxyDirectRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  capture: ResumableUploadProxyCapture,
): void {
  const direct = {
    auth: String(req.headers.authorization ?? ''),
    token: String(req.headers['x-agent-device-token'] ?? ''),
    contentRange: String(req.headers['content-range'] ?? ''),
    body: '',
  };
  capture.direct = direct;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    direct.body += chunk;
  });
  req.on('end', () => {
    res.statusCode = 200;
    res.end('ok');
  });
}

function sendUploadProxyFinalize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  capture: ResumableUploadProxyCapture,
): void {
  capture.finalizeAuth = String(req.headers.authorization ?? '');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, uploadId: 'tracked-upload-1' }));
}
