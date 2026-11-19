import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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

// A benign, owned CONNECT proxy: it tunnels to the loopback target the test owns and is never
// exposed beyond 127.0.0.1. The test completes the tunnel itself so the phase-clock position of
// "upstream established" is exact.
type PendingTunnel = { socket: net.Socket; head: Buffer };

function createOwnedConnectProxy(onConnect: (pending: PendingTunnel) => void): {
  server: http.Server;
  complete: (pending: PendingTunnel, targetPort: number) => void;
  destroyTunnels: () => void;
} {
  const tunnels = new Set<net.Socket>();
  const server = http.createServer((_request, response) => {
    response.writeHead(502).end();
  });
  server.on('connect', (_request, socket, head) => {
    const tunnel = socket as net.Socket;
    tunnels.add(tunnel);
    // Abort teardown resets live tunnels; the reset is the expected end, not a failure.
    tunnel.on('error', () => {});
    tunnel.on('close', () => tunnels.delete(tunnel));
    onConnect({ socket: tunnel, head });
  });
  return {
    server,
    complete: (pending, targetPort) => {
      pending.socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const upstream = net.connect(targetPort, '127.0.0.1');
      upstream.on('error', () => {});
      if (pending.head.length > 0) upstream.write(pending.head);
      pending.socket.pipe(upstream);
      upstream.pipe(pending.socket);
    },
    destroyTunnels: () => {
      for (const socket of tunnels) socket.destroy();
    },
  };
}

async function waitForReal(cond: () => boolean, what: string, guard = 200): Promise<void> {
  for (let index = 0; index < guard; index += 1) {
    if (cond()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test('a loopback CONNECT proxy arms the header phase at tunnel establishment inside its own budget', async () => {
  let pendingResponse: http.ServerResponse | undefined;
  const target = http.createServer((_request, response) => {
    pendingResponse = response;
  });
  const targetPort = await listen(target);
  let pendingTunnel: PendingTunnel | undefined;
  const proxy = createOwnedConnectProxy((pending) => {
    pendingTunnel = pending;
  });
  const proxyPort = await listen(proxy.server);
  const watchdog = createTransferPhaseWatchdog();
  try {
    let connected = false;
    watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
    const outcome = requestApprovedUrl({
      url: new URL(`http://approved.invalid:${targetPort}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: watchdog.signal,
      environment: { http_proxy: `http://127.0.0.1:${proxyPort}` },
      onConnected: () => {
        connected = true;
        watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      },
    })
      .then(async (response) => {
        const body = await text(response.body);
        await response.close();
        return { statusCode: response.statusCode, body };
      })
      .catch((error: unknown) => ({ error }) as const);

    await waitForReal(() => pendingTunnel !== undefined, 'the proxy CONNECT');
    // 10s of phase-clock time pass before the tunnel completes.
    await vi.advanceTimersByTimeAsync(10_000);
    proxy.complete(pendingTunnel!, targetPort);
    await waitForReal(() => connected, 'the tunnel establishment callback');
    assert.equal(connected, true, 'the CONNECT tunnel must report upstream establishment');
    await waitForReal(() => pendingResponse !== undefined, 'the tunneled request at the target');

    // 30s total: the original connect budget has passed. With the pre-fix transport the armed
    // connect phase would expire here; the header phase got its own budget at establishment.
    await vi.advanceTimersByTimeAsync(20_001);
    assert.equal(
      watchdog.signal.aborted,
      false,
      'the connect phase must not stay armed through the tunnel, TLS and header wait',
    );

    // Headers arrive 25s after the tunnel (35s total), inside the header phase's own 30s budget.
    await vi.advanceTimersByTimeAsync(4_999);
    pendingResponse!.end('artifact');
    const result = await outcome;
    assert.ok(!('error' in result), `the request must succeed, got ${String(result)}`);
    if ('error' in result) return;
    assert.equal(result.statusCode, 200);
    assert.equal(result.body, 'artifact');
  } finally {
    watchdog.dispose();
    proxy.destroyTunnels();
    await closeServer(proxy.server);
    await closeServer(target);
  }
});

test('headers that stall behind a loopback CONNECT proxy expire with the typed response-headers phase', async () => {
  const target = http.createServer(() => {
    // Accept the tunneled connection, never answer.
  });
  const targetPort = await listen(target);
  let pendingTunnel: PendingTunnel | undefined;
  const proxy = createOwnedConnectProxy((pending) => {
    pendingTunnel = pending;
  });
  const proxyPort = await listen(proxy.server);
  const watchdog = createTransferPhaseWatchdog();
  try {
    let connected = false;
    watchdog.arm('connect', TRANSFER_CONNECT_TIMEOUT_MS);
    const outcome = requestApprovedUrl({
      url: new URL(`http://approved.invalid:${targetPort}/app.zip`),
      approvedAddress: '127.0.0.1',
      family: 4,
      headers: {},
      signal: watchdog.signal,
      environment: { http_proxy: `http://127.0.0.1:${proxyPort}` },
      onConnected: () => {
        connected = true;
        watchdog.arm('response-headers', TRANSFER_RESPONSE_HEADER_TIMEOUT_MS);
      },
    }).catch((error: unknown) => error);

    await waitForReal(() => pendingTunnel !== undefined, 'the proxy CONNECT');
    await vi.advanceTimersByTimeAsync(10_000);
    proxy.complete(pendingTunnel!, targetPort);
    await waitForReal(() => connected, 'the tunnel establishment callback');
    assert.equal(connected, true, 'the CONNECT tunnel must report upstream establishment');

    // The header wait started at tunnel establishment (10s in) and gets its own 30s.
    await vi.advanceTimersByTimeAsync(30_001);
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
    proxy.destroyTunnels();
    await closeServer(proxy.server);
    await closeServer(target);
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
