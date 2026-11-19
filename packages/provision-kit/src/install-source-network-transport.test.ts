import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  createTransferPhaseWatchdog,
  isTransferPhaseTimeoutError,
  TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
  TRANSFER_CONNECT_TIMEOUT_MS,
  TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
} from '@agent-device/host-kit/transport';
import {
  matchesNoProxy,
  requestApprovedUrl,
  resolveProxyForUrl,
} from './install-source-network-transport.ts';

test('lowercase proxy variables override uppercase even when empty', () => {
  assert.equal(
    resolveProxyForUrl(new URL('http://example.net'), {
      http_proxy: '',
      HTTP_PROXY: 'http://uppercase-proxy',
    }),
    undefined,
  );
  assert.equal(
    resolveProxyForUrl(new URL('https://example.net'), {
      https_proxy: '',
      HTTPS_PROXY: 'http://uppercase-proxy',
      http_proxy: 'http://fallback-proxy',
    }),
    'http://fallback-proxy',
  );
});

test('HTTPS proxy selection falls back to the selected HTTP proxy', () => {
  assert.equal(
    resolveProxyForUrl(new URL('https://example.net'), { http_proxy: 'http://proxy' }),
    'http://proxy',
  );
});

test('NO_PROXY matches exact hosts, subdomains, ports, wildcards, and bracketed IPv6', () => {
  assert.equal(matchesNoProxy(new URL('https://example.com'), 'example.com'), true);
  assert.equal(matchesNoProxy(new URL('https://sub.example.com'), 'example.com'), true);
  assert.equal(matchesNoProxy(new URL('https://example.com:444'), 'example.com:443'), false);
  assert.equal(
    matchesNoProxy(new URL('https://[2001:4860:4860::8888]'), '[2001:4860:4860::8888]'),
    true,
  );
  assert.equal(matchesNoProxy(new URL('https://elsewhere.example'), '*'), true);
});

test('direct requests connect to the approved address through the real lookup', async () => {
  vi.stubEnv('no_proxy', '*');
  const server = http.createServer((_request, response) => response.end('artifact'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await requestApprovedUrl({
      url: new URL(`http://approved.invalid:${port}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: AbortSignal.timeout(5_000),
      environment: process.env,
    });
    try {
      assert.equal(response.statusCode, 200);
      assert.equal(await text(response.body), 'artifact');
    } finally {
      await response.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// The watchdog deadline runs on a faked clock while the loopback server and socket I/O run for
// real, so phase expiry below is driven by an independent control clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function flushRealIOMacrotasks(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('a benign loopback request passes through the phase watchdog untouched', async () => {
  vi.stubEnv('no_proxy', '*');
  const server = http.createServer((_request, response) => response.end('artifact'));
  const port = await listen(server);
  const watchdog = createTransferPhaseWatchdog();
  try {
    let connected = false;
    watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
    const response = await requestApprovedUrl({
      url: new URL(`http://approved.invalid:${port}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: watchdog.signal,
      environment: process.env,
      onConnected: () => {
        connected = true;
        watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      },
    });
    try {
      assert.equal(connected, true, 'the dispatcher must report connection establishment');
      assert.equal(response.statusCode, 200);
      watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
      const chunks: Buffer[] = [];
      response.body.on('data', (chunk: Buffer) => {
        watchdog.touchBody();
        chunks.push(chunk);
      });
      await text(response.body);
      assert.equal(Buffer.concat(chunks).toString('utf8'), 'artifact');
      assert.equal(watchdog.signal.aborted, false);
    } finally {
      await response.close();
    }
  } finally {
    watchdog.dispose();
    await closeServer(server);
  }
});

test('a loopback connection that never answers expires at the header wait with typed evidence', async () => {
  vi.stubEnv('no_proxy', '*');
  const server = http.createServer(() => {
    // Accept the connection, never respond.
  });
  const port = await listen(server);
  const watchdog = createTransferPhaseWatchdog();
  try {
    let connected = false;
    watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
    const outcome = requestApprovedUrl({
      url: new URL(`http://approved.invalid:${port}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: watchdog.signal,
      environment: process.env,
      onConnected: () => {
        connected = true;
        watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      },
    }).catch((error: unknown) => error);
    for (let guard = 0; guard < 100 && !connected; guard += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(connected, true, 'the real connection must establish before the header wait');
    await vi.advanceTimersByTimeAsync(TRANSFER_RESPONSE_HEADER_TIMEOUT_MS + 1);
    const error = await outcome;
    assert.ok(error instanceof Error, 'the stalled request must reject');
    assert.ok(
      isTransferPhaseTimeoutError(watchdog.signal.reason),
      'the exact owner must abort with typed phase evidence',
    );
    assert.deepEqual((watchdog.signal.reason as AppError).details, {
      reason: 'transfer_phase_timeout',
      transferPhase: 'response-headers',
      timeoutMs: TRANSFER_RESPONSE_HEADER_TIMEOUT_MS,
    });
  } finally {
    watchdog.dispose();
    await closeServer(server);
  }
});

test('a loopback body that stalls after accepted bytes expires at the inactivity ceiling', async () => {
  vi.stubEnv('no_proxy', '*');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write('first-chunk');
    // Then stall: no further body bytes.
  });
  const port = await listen(server);
  const watchdog = createTransferPhaseWatchdog();
  try {
    watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
    const response = await requestApprovedUrl({
      url: new URL(`http://approved.invalid:${port}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: watchdog.signal,
      environment: process.env,
      onConnected: () => watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS),
    });
    try {
      watchdog.arm('response-body', TRANSFER_BODY_INACTIVITY_TIMEOUT_MS);
      const received: Buffer[] = [];
      const bodyError = new Promise<unknown>((resolve) => {
        response.body.on('error', resolve);
      });
      response.body.on('data', (chunk: Buffer) => {
        watchdog.touchBody();
        received.push(chunk);
      });
      await flushRealIOMacrotasks();
      assert.equal(Buffer.concat(received).toString('utf8'), 'first-chunk');
      await vi.advanceTimersByTimeAsync(TRANSFER_BODY_INACTIVITY_TIMEOUT_MS + 1);
      await bodyError;
      assert.ok(isTransferPhaseTimeoutError(watchdog.signal.reason));
      assert.deepEqual((watchdog.signal.reason as AppError).details, {
        reason: 'transfer_phase_timeout',
        transferPhase: 'response-body',
        timeoutMs: TRANSFER_BODY_INACTIVITY_TIMEOUT_MS,
      });
    } finally {
      await response.close().catch(() => {});
    }
  } finally {
    watchdog.dispose();
    await closeServer(server);
  }
});
