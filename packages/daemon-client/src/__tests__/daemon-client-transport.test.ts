import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { withDiagnosticsScope } from '@agent-device/host-kit/diagnostics';
import {
  closeLoopbackServer,
  listenOnLoopback,
  mkdtempForTestSync,
  skipWhenLoopbackUnavailable,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { test, vi } from 'vitest';
import * as hostTransport from '@agent-device/host-kit/transport';
import { sleep } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import {
  DAEMON_HTTP_INSTANCE_HEADER,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
  DAEMON_REQUEST_MAX_BYTES,
  DAEMON_RPC_PROTOCOL_VERSION,
} from '@agent-device/contracts/daemon-http';
import { sendToDaemon } from '../index.ts';
import {
  canConnect,
  isDaemonTransportUnavailableError,
  sendRequest,
} from '../daemon-client-transport.ts';
import { REMOTE_DAEMON_UNAVAILABLE_REASON } from '../daemon-lifecycle-errors.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createDaemonProxyServer } from '@agent-device/proxy';

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
    { host: createTestHostEnvironment() },
  );
}

test('auto health probing reserves time for a healthy fallback when HTTP hangs', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const httpServer = http.createServer(() => {});
  const socketServer = net.createServer((socket) => socket.on('error', () => {}));
  try {
    const httpPort = await listenOnLoopback(httpServer);
    const port = await listenOnLoopback(socketServer);
    assert.equal(
      await canConnect({ token: 'secret', pid: 1, transport: 'http', httpPort, port }, 'auto', 120),
      true,
    );
  } finally {
    await closeLoopbackServer(httpServer);
    await closeLoopbackServer(socketServer);
  }
});

test('the health deadline includes requester loading and forbids a late request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.end('{}');
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actualLoad = hostTransport.loadNodeHttpRequester;
  const load = vi
    .spyOn(hostTransport, 'loadNodeHttpRequester')
    .mockImplementation(async (protocol) => {
      await blocked;
      return actualLoad(protocol);
    });
  let probing: Promise<boolean> | undefined;
  try {
    const httpPort = await listenOnLoopback(server);
    let settled = false;
    probing = canConnect({ token: 'secret', pid: 1, httpPort }, 'http', 40).then((reachable) => {
      settled = true;
      return reachable;
    });
    await sleep(90);
    assert.equal(settled, true, 'loading must not extend the probe deadline');
    assert.equal(await probing, false);
    release();
    await blocked;
    await sleep(10);
    assert.equal(requests, 0, 'a timed-out loader must not open a request later');
  } finally {
    release();
    await probing;
    load.mockRestore();
    await closeLoopbackServer(server);
  }
});

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

type RestartProbeFailure = 'http-503' | 'closed-connection' | 'refused-connection';

async function assertRestartProbeFailureReportsUnavailable(
  t: Parameters<typeof skipWhenLoopbackUnavailable>[0],
  failure: RestartProbeFailure,
) {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let healthProbes = 0;
  let rpcCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      healthProbes += 1;
      if (failure === 'http-503') {
        res.statusCode = 503;
        res.end();
      } else {
        req.socket.destroy();
      }
      return;
    }
    rpcCount += 1;
    res.statusCode = 409;
    res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
    res.setHeader('connection', 'close');
    res.end();
    if (failure === 'refused-connection') server.close();
  });
  try {
    const port = await listenOnLoopback(server);
    await assert.rejects(sendWithStaleInstance(port, 150), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.message, 'Remote daemon is unavailable');
      assert.equal(error.details?.reason, REMOTE_DAEMON_UNAVAILABLE_REASON);
      assert.equal(error.details?.dispatched, 'no');
      assert.equal(error.details?.daemonBaseUrl, `http://127.0.0.1:${port}`);
      assert.notEqual(error.details?.reason, 'daemon_transport_timeout');
      return true;
    });
    assert.equal(rpcCount, 1);
    // A closed listener cannot count the probe; its attempt is proven by elimination: a skipped
    // probe would exhaust the budget and report daemon_transport_timeout, which the error check rejects.
    if (failure !== 'refused-connection') assert.equal(healthProbes, 1);
  } finally {
    await closeLoopbackServer(server);
  }
}

// Catches a mutation that marks every unreachable restart probe timedOut: a probe that fails
// outright inside the capped budget would then surface as an RPC timeout.
test('a restart health probe answering 503 near the RPC deadline reports the daemon unavailable', async (t) => {
  await assertRestartProbeFailureReportsUnavailable(t, 'http-503');
});

test('a restart health probe on a closed connection near the RPC deadline reports the daemon unavailable', async (t) => {
  await assertRestartProbeFailureReportsUnavailable(t, 'closed-connection');
});

test('a restart health probe refused near the RPC deadline reports the daemon unavailable', async (t) => {
  await assertRestartProbeFailureReportsUnavailable(t, 'refused-connection');
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

test.for(['socket', 'http'] as const)(
  'a %s request over the daemon request limit is refused before it is sent',
  async (transport, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    let connections = 0;
    const server = transport === 'socket' ? net.createServer() : http.createServer();
    server.on('connection', (socket: net.Socket) => {
      connections += 1;
      socket.destroy();
    });
    const port = await listenOnLoopback(server);
    try {
      const replayScriptSource = {
        entry: 'flow.ad',
        files: { 'flow.ad': 'x'.repeat(DAEMON_REQUEST_MAX_BYTES) },
      };
      const refusal = await sendRequest(
        transport === 'socket'
          ? { port, token: 't', pid: 1 }
          : { httpPort: port, token: 't', pid: 1 },
        {
          token: 't',
          session: 'default',
          command: 'replay',
          positionals: [],
          flags: { replayScriptSource },
        },
        transport,
        resolveDaemonPaths('/tmp/agent-device-request-limit-test'),
        undefined,
        { host: createTestHostEnvironment() },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(refusal instanceof AppError);
      assert.equal(refusal.code, 'INVALID_ARGS');
      assert.equal(refusal.details?.reason, 'daemon_request_too_large');
      assert.equal(refusal.details?.daemonRequestSent, false);
      assert.equal(connections, 0);
    } finally {
      await closeLoopbackServer(server);
    }
  },
);

test.for([
  { overBy: 0, sent: true },
  { overBy: 1, sent: false },
])(
  'a socket request $overBy bytes over the limit, without its newline, is sent: $sent',
  async ({ overBy, sent }, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    let receivedBytes = 0;
    // The server reads the whole request line, then drops the connection without answering.
    const server = net.createServer((socket) => {
      socket.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (chunk.includes(0x0a)) socket.destroy();
      });
    });
    const port = await listenOnLoopback(server);
    const request = (flow: string) => ({
      token: 't',
      session: 'default',
      command: 'replay',
      positionals: [],
      flags: { replayScriptSource: { entry: 'flow.ad', files: { 'flow.ad': flow } } },
      meta: { requestId: 'request-limit-boundary' },
    });
    const overhead = Buffer.byteLength(JSON.stringify(request('')));
    try {
      const outcome = await sendRequest(
        { port, token: 't', pid: 1 },
        request('x'.repeat(DAEMON_REQUEST_MAX_BYTES - overhead + overBy)),
        'socket',
        resolveDaemonPaths('/tmp/agent-device-request-limit-test'),
        undefined,
        { host: createTestHostEnvironment() },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(outcome instanceof AppError);
      assert.equal(outcome.details?.reason === 'daemon_request_too_large', !sent);
      if (!sent) assert.equal(outcome.details?.daemonRequestSent, false);
      // The whole request and its framing newline reached the daemon, or nothing did.
      assert.equal(receivedBytes, sent ? DAEMON_REQUEST_MAX_BYTES + 1 : 0);
    } finally {
      await closeLoopbackServer(server);
    }
  },
);

test('an endpoint missing for the requested transport rejects with a typed reason the classifier accepts', async () => {
  const socketOnly = { port: 1, token: 't', pid: 1 };
  const error = await canConnect(socketOnly, 'http').then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(error instanceof AppError);
  assert.equal(error.details?.reason, 'daemon_endpoint_unavailable');
  assert.equal(error.details?.transport, 'http');
  assert.equal(isDaemonTransportUnavailableError(error), true);
});

test('the classifier ignores message text', () => {
  assert.equal(
    isDaemonTransportUnavailableError(
      new AppError('COMMAND_FAILED', 'Daemon HTTP endpoint is unavailable'),
    ),
    false,
  );
  assert.equal(
    isDaemonTransportUnavailableError(
      new AppError('COMMAND_FAILED', 'reworded', { reason: 'daemon_endpoint_unavailable' }),
    ),
    true,
  );
});

test.for(['timeout', 'reset'] as const)(
  'HTTP %s reports only its own transport outcome',
  async (mode, t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    const server = http.createServer((request) => {
      if (mode === 'reset') request.socket.destroy();
    });
    const paths = resolveDaemonPaths(mkdtempForTestSync('http-outcome-'));
    const logPath = path.join(paths.baseDir, 'diagnostics.ndjson');
    try {
      const port = await listenOnLoopback(server);
      await assert.rejects(
        withDiagnosticsScope({ debug: true, logPath }, () =>
          sendRequest(
            { baseUrl: `http://127.0.0.1:${port}`, token: 'secret', pid: 1 },
            { token: 'secret', command: 'devices', session: 'default', positionals: [], flags: {} },
            'http',
            paths,
            mode === 'timeout' ? 40 : 1_000,
            { host: createTestHostEnvironment() },
          ),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.details?.reason === 'daemon_transport_timeout', mode === 'timeout');
          return true;
        },
      );
      await sleep(30);
      const events = fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(
        events.filter((event) => event.phase === 'daemon_request_socket_error').length,
        mode === 'timeout' ? 0 : 1,
      );
    } finally {
      await closeLoopbackServer(server);
    }
  },
);
