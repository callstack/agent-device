import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { Dispatcher } from 'undici';
import { AppError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../../../__tests__/test-utils/loopback.ts';

const approveDownloadSourceUrl = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/provision-kit/install-source-network', () => ({
  approveDownloadSourceUrl,
}));

import {
  executeRunScriptHttpRequest,
  MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES,
  PublicFetchDispatcher,
} from '../run-script-http.ts';

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('keeps local requests on the existing Fetch path', async () => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response('created', {
      status: 201,
      headers: { 'x-result': 'ok' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);

  const result = await executeRunScriptHttpRequest({
    method: 'POST',
    url: 'http://127.0.0.1:8080/local',
    headers: { authorization: 'secret' },
    body: '{}',
    publicNetworkOnly: false,
  });

  assert.deepEqual(result, {
    status: 201,
    body: 'created',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-result': 'ok' },
  });
  assert.deepEqual(fetchMock.mock.calls[0], [
    'http://127.0.0.1:8080/local',
    { method: 'POST', headers: { authorization: 'secret' }, body: '{}' },
  ]);
});

test('preserves Fetch decompression for public requests', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const server = http.createServer((_req, res) => {
    const body = gzipSync('decoded');
    res.writeHead(200, {
      'content-encoding': 'gzip',
      'content-length': String(body.byteLength),
    });
    res.end(body);
  });
  try {
    const port = await listenOnLoopback(server);
    approveDownloadSourceUrl.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    const result = await executeRunScriptHttpRequest({
      method: 'POST',
      url: `http://public.test:${port}/data`,
      headers: {},
      body: '{}',
      publicNetworkOnly: true,
    });

    assert.equal(result.body, 'decoded');
  } finally {
    await closeLoopbackServer(server);
  }
});

test('uses Fetch cross-origin 307 header and body semantics', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let redirectedHeaders: http.IncomingHttpHeaders | undefined;
  let redirectedBody = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/start') {
      const port = (server.address() as { port: number }).port;
      res.writeHead(307, { location: `http://other.test:${port}/next` });
      res.end();
      return;
    }
    redirectedHeaders = req.headers;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      redirectedBody += chunk;
    });
    req.on('end', () => res.end('ok'));
  });
  try {
    const port = await listenOnLoopback(server);
    approveDownloadSourceUrl.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    const result = await executeRunScriptHttpRequest({
      method: 'POST',
      url: `http://public.test:${port}/start`,
      headers: {
        authorization: 'secret',
        'content-type': 'application/json',
      },
      body: '{}',
      publicNetworkOnly: true,
    });

    assert.equal(result.body, 'ok');
    assert.equal(redirectedHeaders?.authorization, undefined);
    assert.equal(redirectedHeaders?.['content-type'], 'application/json');
    assert.equal(redirectedBody, '{}');
    assert.equal(approveDownloadSourceUrl.mock.calls.length, 2);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('reapproves a redirect before its connection', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    const port = (server.address() as { port: number }).port;
    res.writeHead(302, { location: `http://private.test:${port}/secret` });
    res.end();
  });
  try {
    const port = await listenOnLoopback(server);
    approveDownloadSourceUrl
      .mockResolvedValueOnce({ address: '127.0.0.1', family: 4 })
      .mockRejectedValueOnce(new AppError('INVALID_ARGS', 'non-public address'));

    await assert.rejects(
      executeRunScriptHttpRequest({
        method: 'GET',
        url: `http://public.test:${port}/start`,
        headers: {},
        publicNetworkOnly: true,
      }),
      /non-public address/,
    );
    assert.equal(requests, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('validates an IP literal before connecting', async () => {
  approveDownloadSourceUrl.mockRejectedValue(new AppError('INVALID_ARGS', 'non-public address'));

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'http://169.254.169.254/latest/meta-data',
      headers: {},
      publicNetworkOnly: true,
    }),
    /non-public address/,
  );
  assert.equal(approveDownloadSourceUrl.mock.calls.length, 1);
});

test('preserves configured proxy routing while pinning the approved destination', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let connectTarget = '';
  let targetHost = '';
  const target = http.createServer((req, res) => {
    targetHost = req.headers.host ?? '';
    res.end('proxied');
  });
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    connectTarget = req.url ?? '';
    const [host, rawPort] = connectTarget.split(':');
    const upstream = net.connect(Number(rawPort), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.byteLength > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  });
  try {
    const targetPort = await listenOnLoopback(target);
    const proxyPort = await listenOnLoopback(proxy);
    vi.stubEnv('http_proxy', `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv('no_proxy', '');
    vi.stubEnv('NO_PROXY', '');
    approveDownloadSourceUrl.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    const result = await executeRunScriptHttpRequest({
      method: 'GET',
      url: `http://public.test:${targetPort}/data`,
      headers: {},
      publicNetworkOnly: true,
    });

    assert.equal(result.body, 'proxied');
    assert.equal(connectTarget, `127.0.0.1:${targetPort}`);
    assert.equal(targetHost, `public.test:${targetPort}`);
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(target);
  }
});

test('rejects an HTTPS downgrade before approval or dispatch', async () => {
  const dispatcher = new PublicFetchDispatcher(true, AbortSignal.timeout(1_000));
  const error = await new Promise<Error>((resolve) => {
    dispatcher.dispatch({ origin: 'http://example.test', path: '/redirected', method: 'GET' }, {
      onError: resolve,
    } as Dispatcher.DispatchHandler);
  });

  assert.match(error.message, /redirect downgraded HTTPS/);
  assert.equal(approveDownloadSourceUrl.mock.calls.length, 0);
  await dispatcher.dispose();
});

test('caps the decoded public response body', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const server = http.createServer((_req, res) => {
    res.end(Buffer.alloc(MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES + 1, 0x61));
  });
  try {
    const port = await listenOnLoopback(server);
    approveDownloadSourceUrl.mockResolvedValue({ address: '127.0.0.1', family: 4 });

    await assert.rejects(
      executeRunScriptHttpRequest({
        method: 'GET',
        url: `http://public.test:${port}/large`,
        headers: {},
        publicNetworkOnly: true,
      }),
      new RegExp(`response exceeded ${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES} bytes`),
    );
  } finally {
    await closeLoopbackServer(server);
  }
});
