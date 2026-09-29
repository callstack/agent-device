import assert from 'node:assert/strict';
import http from 'node:http';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import {
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { sendToDaemon } from '../daemon-client.ts';
import { sendRequest } from '../daemon-client-transport.ts';
import { resolveDaemonPaths } from '../../daemon-resolution.ts';
import { createDaemonProxyServer } from '../../remote/daemon-proxy.ts';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '../../__tests__/test-utils/loopback.ts';

function sendWithStaleInstance(port: number, timeoutMs: number) {
  return sendRequest(
    {
      baseUrl: `http://127.0.0.1:${port}`,
      token: 'secret',
      pid: 1,
      remoteInstanceId: 'previous-instance',
    },
    { token: 'secret', command: 'devices', session: 'default', positionals: [], flags: {} },
    'auto',
    resolveDaemonPaths('/tmp/agent-device-instance-retry-test'),
    timeoutMs,
  );
}

test('persistent remote client caches health and retries a refused stale instance before dispatch', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const paths: string[] = [];
  const rpcHeaders: (string | undefined)[] = [];
  let executed = 0;
  let failRpc = false;
  let daemonError = false;
  let rpcProtocolVersion: number = DAEMON_RPC_PROTOCOL_VERSION;
  let instanceId = 'first-instance';
  let legacy = false;
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith('/health')) {
      res.end(
        JSON.stringify({
          ok: true,
          service: 'agent-device-daemon',
          version: '1.0.0',
          rpcProtocolVersion,
          ...(legacy ? {} : { instanceId }),
        }),
      );
      return;
    }
    rpcHeaders.push(req.headers[DAEMON_HTTP_INSTANCE_HEADER] as string | undefined);
    if (failRpc) {
      req.socket.destroy();
      return;
    }
    const expected = req.headers[DAEMON_HTTP_INSTANCE_HEADER];
    if (typeof expected === 'string' && expected !== instanceId) {
      res.statusCode = 409;
      res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'request', error: { code: -32001 } }));
      return;
    }
    executed += 1;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        daemonError
          ? {
              jsonrpc: '2.0',
              id: 'request',
              error: { code: -32001, message: 'Command refused', data: { code: 'INVALID_ARGS' } },
            }
          : { jsonrpc: '2.0', id: 'request', result: { ok: true, data: {} } },
      ),
    );
  });
  try {
    const port = await listenOnLoopback(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = (token: string, url = baseUrl) =>
      sendToDaemon(
        {
          command: 'remote-smoke',
          session: 'default',
          positionals: ['ping'],
          flags: { daemonBaseUrl: url },
          meta: { requestId: 'request' },
        },
        { authToken: token },
      );
    const incompatible = (error: unknown) =>
      error instanceof AppError &&
      error.details?.remoteRpcProtocolVersion === DAEMON_RPC_PROTOCOL_VERSION + 1;

    assert.equal((await request('first')).ok, true);
    assert.equal((await request('first')).ok, true);
    assert.deepEqual(paths, ['GET /health', 'POST /rpc', 'POST /rpc']);
    assert.deepEqual(rpcHeaders, ['first-instance', 'first-instance']);

    assert.equal((await request('second')).ok, true);
    assert.deepEqual(paths.slice(3), ['GET /health', 'POST /rpc']);

    daemonError = true;
    await assert.rejects(
      request('second'),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
    daemonError = false;
    assert.equal((await request('second')).ok, true);
    assert.deepEqual(paths.slice(5, 7), ['POST /rpc', 'POST /rpc']);

    failRpc = true;
    await assert.rejects(request('second'));
    failRpc = false;
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION + 1;
    await assert.rejects(request('second'), incompatible);
    assert.deepEqual(paths.slice(7, 9), ['POST /rpc', 'GET /health']);
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION;
    assert.equal((await request('second')).ok, true);
    assert.deepEqual(paths.slice(9, 11), ['GET /health', 'POST /rpc']);

    assert.equal((await request('second', `${baseUrl}/alt`)).ok, true);
    assert.deepEqual(paths.slice(11, 13), ['GET /alt/health', 'POST /alt/rpc']);

    instanceId = 'replacement-instance';
    const beforeRestart = executed;
    assert.equal((await request('second', `${baseUrl}/alt`)).ok, true);
    assert.deepEqual(paths.slice(13, 16), ['POST /alt/rpc', 'GET /alt/health', 'POST /alt/rpc']);
    assert.equal(executed, beforeRestart + 1);
    assert.deepEqual(rpcHeaders.slice(-2), ['first-instance', 'replacement-instance']);
    assert.equal((await request('second', `${baseUrl}/alt`)).ok, true);
    assert.deepEqual(paths.slice(16, 17), ['POST /alt/rpc']);

    instanceId = 'incompatible-instance';
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION + 1;
    const beforeSkew = executed;
    await assert.rejects(request('second', `${baseUrl}/alt`), incompatible);
    assert.deepEqual(paths.slice(17, 19), ['POST /alt/rpc', 'GET /alt/health']);
    assert.equal(executed, beforeSkew);

    legacy = true;
    rpcProtocolVersion = DAEMON_RPC_PROTOCOL_VERSION;
    assert.equal((await request('legacy')).ok, true);
    assert.equal((await request('legacy')).ok, true);
    assert.deepEqual(paths.slice(19), ['GET /health', 'POST /rpc', 'GET /health', 'POST /rpc']);
    assert.deepEqual(rpcHeaders.slice(-2), [undefined, undefined]);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('instance retry uses the remaining request timeout', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let rpcCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify({ ok: true, instanceId: 'replacement-instance' }));
      return;
    }
    rpcCount += 1;
    if (rpcCount === 1) {
      setTimeout(() => {
        res.statusCode = 409;
        res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
        res.end();
      }, 80);
    }
  });
  try {
    const port = await listenOnLoopback(server);
    await assert.rejects(
      sendWithStaleInstance(port, 400),
      (error: unknown) =>
        error instanceof AppError &&
        error.details?.reason === 'daemon_transport_timeout' &&
        typeof error.details.timeoutMs === 'number' &&
        error.details.timeoutMs < 400,
    );
    assert.equal(rpcCount, 2);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a delayed restart health probe stops at the RPC deadline without retrying', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let rpcCount = 0;
  let healthResponded = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const delayedResponse = setTimeout(() => {
        healthResponded = true;
        res.end(JSON.stringify({ ok: true, instanceId: 'replacement-instance' }));
      }, 1000);
      res.on('close', () => clearTimeout(delayedResponse));
      return;
    }
    rpcCount += 1;
    res.statusCode = 409;
    res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
    res.end();
  });
  try {
    const port = await listenOnLoopback(server);
    await assert.rejects(
      sendWithStaleInstance(port, 150),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_transport_timeout',
    );
    assert.equal(healthResponded, false);
    assert.equal(rpcCount, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});

test('a restart health probe cut short by the RPC deadline reports the deadline on a lagging clock', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let rpcCount = 0;
  let healthProbes = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      healthProbes += 1;
      const delayedResponse = setTimeout(() => res.end('{}'), 1000);
      res.on('close', () => clearTimeout(delayedResponse));
      return;
    }
    rpcCount += 1;
    res.statusCode = 409;
    res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
    res.end();
  });
  // Timers start from the event loop's cached clock, so the probe's timer can fire while
  // performance.now() is still short of the deadline. A frozen clock makes that gap certain.
  const now = vi.spyOn(performance, 'now').mockReturnValue(performance.now());
  try {
    const port = await listenOnLoopback(server);
    await assert.rejects(
      sendWithStaleInstance(port, 150),
      (error: unknown) =>
        error instanceof AppError && error.details?.reason === 'daemon_transport_timeout',
    );
    assert.equal(rpcCount, 1);
    assert.equal(healthProbes, 1);
  } finally {
    now.mockRestore();
    await closeLoopbackServer(server);
  }
});

test('proxy forwards cached upstream identity and rejects a restarted upstream before dispatch', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let upstreamInstance = 'upstream-one';
  let protocolVersion: number = DAEMON_RPC_PROTOCOL_VERSION;
  let executed = 0;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.end(
        JSON.stringify({
          ok: true,
          service: 'agent-device-daemon',
          version: '1.0.0',
          rpcProtocolVersion: protocolVersion,
          instanceId: upstreamInstance,
        }),
      );
      return;
    }
    const expected = req.headers[DAEMON_HTTP_INSTANCE_HEADER];
    if (typeof expected === 'string' && expected !== upstreamInstance) {
      res.statusCode = 409;
      res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'request', error: { code: -32001 } }));
      return;
    }
    executed += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'request', result: { ok: true, data: {} } }));
  });
  const upstreamPort = await listenOnLoopback(upstream);
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    upstreamToken: 'upstream-secret',
    clientToken: 'client-secret',
  });
  try {
    const proxyPort = await listenOnLoopback(proxy);
    const request = () =>
      sendToDaemon(
        {
          command: 'remote-smoke',
          session: 'default',
          positionals: ['ping'],
          flags: { daemonBaseUrl: `http://127.0.0.1:${proxyPort}/agent-device/` },
          meta: { requestId: 'request' },
        },
        { authToken: 'client-secret' },
      );
    assert.equal((await request()).ok, true);
    assert.equal(executed, 1);
    upstreamInstance = 'upstream-two';
    assert.equal((await request()).ok, true);
    assert.equal(executed, 2);
    upstreamInstance = 'upstream-incompatible';
    protocolVersion = DAEMON_RPC_PROTOCOL_VERSION + 1;
    await assert.rejects(
      request(),
      (error: unknown) =>
        error instanceof AppError && error.details?.remoteRpcProtocolVersion === protocolVersion,
    );
    assert.equal(executed, 2);
  } finally {
    await closeLoopbackServer(proxy);
    await closeLoopbackServer(upstream);
  }
});
