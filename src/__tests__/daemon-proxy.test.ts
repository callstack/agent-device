import { test } from 'vitest';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createDaemonProxyServer } from '../remote/daemon-proxy.ts';
import { createDaemonHttpServer } from '../daemon/server/http-server.ts';
import { executeRunScriptHttpRequest } from '../daemon/adapters/maestro/run-script-http.ts';
import {
  DAEMON_HTTP_NETWORK_ACCESS_HEADER,
  DAEMON_HTTP_PUBLIC_NETWORK_ACCESS,
} from '../daemon/http-contract.ts';
import { DAEMON_RPC_PROTOCOL_VERSION } from '../daemon/http-health.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from './test-utils/loopback.ts';

const PROXY_ARTIFACT_INVENTORY_ENTRY = {
  id: 'shot-1',
  filename: 'shot.png',
  mimeType: 'image/png',
  sizeBytes: 8,
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:15:00.000Z',
};

test('daemon proxy forwards rpc requests with upstream daemon token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let upstreamAuth = '';
  let upstreamTokenHeader = '';
  let upstreamNetworkAccess = '';
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
    upstreamNetworkAccess = String(req.headers[DAEMON_HTTP_NETWORK_ACCESS_HEADER] ?? '');
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
    assert.equal(upstreamNetworkAccess, DAEMON_HTTP_PUBLIC_NETWORK_ACCESS);
    assert.equal(upstreamBody?.params?.token, 'daemon-secret');
    assert.equal(upstreamBody?.params?.command, 'devices');
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

test('proxy enforces public-only Maestro HTTP policy on a local daemon', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  let loopbackRequests = 0;
  const loopbackTarget = http.createServer((_req, res) => {
    loopbackRequests += 1;
    res.end('loopback-secret');
  });
  const env = { ...process.env };
  delete env.AGENT_DEVICE_HTTP_AUTH_HOOK;
  delete env.AGENT_DEVICE_HTTP_AUTH_EXPORT;
  const daemon = await createDaemonHttpServer({
    token: 'daemon-secret',
    env,
    handleRequest: async (request) => {
      const url = request.positionals[0] ?? '';
      return {
        ok: true,
        data: await executeRunScriptHttpRequest({
          method: 'GET',
          url,
          headers: {},
          publicNetworkOnly: request.internal?.publicNetworkOnly === true,
        }),
      };
    },
  });
  const targetPort = await listenOnLoopback(loopbackTarget);
  const daemonPort = await listenOnLoopback(daemon);
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${daemonPort}`,
    upstreamToken: 'daemon-secret',
    clientToken: 'proxy-secret',
  });

  try {
    const proxyPort = await listenOnLoopback(proxy);
    const post = async (url: string) => {
      const response = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer proxy-secret' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'proxy-trust',
          method: 'agent_device.command',
          params: {
            token: 'proxy-secret',
            command: 'run_script_http',
            positionals: [url],
            flags: {},
          },
        }),
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };

    const loopbackResponse = await post(`http://127.0.0.1:${targetPort}/secret`);
    assert.equal(loopbackResponse.status, 400, JSON.stringify(loopbackResponse.body));
    assert.equal(loopbackResponse.body.error?.data?.code, 'INVALID_ARGS');
    assert.match(loopbackResponse.body.error?.message ?? '', /non-public address/);
    assert.equal(loopbackRequests, 0, 'the proxy path must never reach a loopback target');
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(daemon);
    await closeLoopbackServer(loopbackTarget);
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

test('daemon proxy does not expose local human-control administration', async (t) => {
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
    const response = await fetch(
      `http://127.0.0.1:${String(proxyPort)}/agent-device/admin/human-control/holds`,
      { headers: { authorization: 'Bearer proxy-secret' } },
    );
    assert.equal(response.status, 404);
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

  const capture: UploadAndArtifactProxyCapture = {};
  const upstream = createUploadAndArtifactProxyUpstream(capture);
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
    assert.deepEqual(capture.upload, {
      auth: 'Bearer daemon-secret',
      token: 'daemon-secret',
      artifactType: 'file',
      artifactFilename: 'demo.apk',
      body: 'fake-apk',
    });

    const artifactList = await fetch(`http://127.0.0.1:${proxyPort}/agent-device/artifacts`, {
      headers: { authorization: 'Bearer proxy-secret' },
    });
    assert.equal(artifactList.status, 200);
    assert.deepEqual(await artifactList.json(), {
      artifacts: [PROXY_ARTIFACT_INVENTORY_ENTRY],
    });
    assert.deepEqual(capture.artifactList, {
      auth: 'Bearer daemon-secret',
      token: 'daemon-secret',
    });

    const artifact = await fetch(
      `http://127.0.0.1:${proxyPort}/agent-device/artifacts/shot-1?download=1`,
      { headers: { authorization: 'Bearer proxy-secret' } },
    );
    assert.equal(artifact.status, 200);
    assert.equal(await artifact.text(), 'png-body');
    assert.equal(artifact.headers.get('content-type'), 'image/png');
    assert.match(artifact.headers.get('content-disposition') ?? '', /shot\.png/);
    assert.equal(artifact.headers.get('x-request-id'), 'upstream-request-1');
    assert.deepEqual(capture.artifactDownload, {
      auth: 'Bearer daemon-secret',
      token: 'daemon-secret',
    });
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});

type UploadAndArtifactProxyCapture = {
  upload?: {
    auth: string;
    token: string;
    artifactType: string;
    artifactFilename: string;
    body: string;
  };
  artifactList?: {
    auth: string;
    token: string;
  };
  artifactDownload?: {
    auth: string;
    token: string;
  };
};

function createUploadAndArtifactProxyUpstream(capture: UploadAndArtifactProxyCapture): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/upload') {
      handleUploadProxyRequest(req, res, capture);
      return;
    }
    if (req.method === 'GET' && req.url === '/artifacts') {
      handleArtifactListProxyRequest(req, res, capture);
      return;
    }
    handleArtifactDownloadProxyRequest(req, res, capture);
  });
}

function handleUploadProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  capture: UploadAndArtifactProxyCapture,
): void {
  let body = '';
  capture.upload = {
    auth: String(req.headers.authorization ?? ''),
    token: String(req.headers['x-agent-device-token'] ?? ''),
    artifactType: String(req.headers['x-artifact-type'] ?? ''),
    artifactFilename: String(req.headers['x-artifact-filename'] ?? ''),
    body,
  };
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    capture.upload = { ...capture.upload!, body };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, uploadId: 'upload-1' }));
  });
}

function handleArtifactListProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  capture: UploadAndArtifactProxyCapture,
): void {
  capture.artifactList = {
    auth: String(req.headers.authorization ?? ''),
    token: String(req.headers['x-agent-device-token'] ?? ''),
  };
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ artifacts: [PROXY_ARTIFACT_INVENTORY_ENTRY] }));
}

function handleArtifactDownloadProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  capture: UploadAndArtifactProxyCapture,
): void {
  assert.equal(req.method, 'GET');
  assert.equal(req.url, '/artifacts/shot-1?download=1');
  capture.artifactDownload = {
    auth: String(req.headers.authorization ?? ''),
    token: String(req.headers['x-agent-device-token'] ?? ''),
  };
  res.setHeader('content-type', 'image/png');
  res.setHeader('content-disposition', 'attachment; filename="shot.png"');
  res.setHeader('x-request-id', 'upstream-request-1');
  res.write('png-');
  res.end('body');
}

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

type ProxyRpcOutcome = {
  status: number;
  body: { error?: { code?: number; message?: string; data?: { code?: string } } };
  upstreamCalls: number;
};

async function postInstallRpcThroughProxy(
  params: Record<string, unknown>,
): Promise<ProxyRpcOutcome> {
  let upstreamCalls = 0;
  const upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: (JSON.parse(body) as { id?: unknown }).id,
          result: { ok: true, data: { reached: 'upstream' } },
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
      headers: { 'content-type': 'application/json', authorization: 'Bearer proxy-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'req-1', ...params }),
    });
    return {
      status: response.status,
      body: (await response.json()) as ProxyRpcOutcome['body'],
      upstreamCalls,
    };
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
}

test('proxy refuses a host path install source on the generic command method', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { status, body, upstreamCalls } = await postInstallRpcThroughProxy({
    method: 'agent_device.command',
    params: {
      token: 'proxy-secret',
      command: 'install_source',
      positionals: [],
      flags: { platform: 'android' },
      meta: { installSource: { kind: 'path', path: '/etc/passwd' } },
    },
  });

  assert.equal(status, 400);
  assert.equal(body.error?.code, -32602);
  assert.equal(body.error?.data?.code, 'INVALID_ARGS');
  assert.equal(upstreamCalls, 0, 'the daemon must never see a proxied host path source');
});

test('proxy refuses a host path install source on the install_from_source method', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { status, body, upstreamCalls } = await postInstallRpcThroughProxy({
    method: 'agent_device.install_from_source',
    params: {
      token: 'proxy-secret',
      platform: 'android',
      source: { kind: 'path', path: '/etc/passwd' },
    },
  });

  assert.equal(status, 400);
  assert.equal(body.error?.data?.code, 'INVALID_ARGS');
  assert.equal(upstreamCalls, 0);
});

test('proxy forwards a path source backed by an uploaded artifact', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { status, upstreamCalls } = await postInstallRpcThroughProxy({
    method: 'agent_device.command',
    params: {
      token: 'proxy-secret',
      command: 'install_source',
      positionals: [],
      flags: { platform: 'android' },
      meta: {
        installSource: { kind: 'path', path: '/Users/dev/Downloads/Sample.apk' },
        uploadedArtifactId: 'upload-1',
      },
    },
  });

  assert.equal(status, 200);
  assert.equal(upstreamCalls, 1);
});

test('proxy forwards url install sources unchanged', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;

  const { status, upstreamCalls } = await postInstallRpcThroughProxy({
    method: 'agent_device.install_from_source',
    params: {
      token: 'proxy-secret',
      platform: 'android',
      source: { kind: 'url', url: 'https://example.com/app.apk' },
    },
  });

  assert.equal(status, 200);
  assert.equal(upstreamCalls, 1);
});
