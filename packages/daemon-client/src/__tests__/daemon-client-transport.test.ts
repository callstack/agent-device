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
  isDaemonTransportUnavailableError,
  probeDaemonReachability,
  sendRequest,
} from '../daemon-client-transport.ts';
import { DAEMON_UNAVAILABLE_REASONS } from '../daemon-lifecycle-errors.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createDaemonProxyServer } from '@agent-device/proxy';
import { invalidateRemoteDaemonHealth } from '../daemon-client-remote-health-cache.ts';

// Calls through to the real cache, so only the invalidation test reads the spy.
vi.mock('../daemon-client-remote-health-cache.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../daemon-client-remote-health-cache.ts')>();
  return { ...actual, invalidateRemoteDaemonHealth: vi.fn(actual.invalidateRemoteDaemonHealth) };
});

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
      (
        await probeDaemonReachability(
          { token: 'secret', pid: 1, transport: 'http', httpPort, port },
          'auto',
          120,
        )
      ).reachable,
      true,
    );
  } finally {
    await closeLoopbackServer(httpServer);
    await closeLoopbackServer(socketServer);
  }
});

// A reachability probe shape that a boolean "unreachable" would report wrongly, and that a caller
// reads before it retires a daemon: a fallback leg that answers AFTER the deadline must not bury the
// refusal the first leg already proved.
test('a fallback leg answering past the deadline still reports the first leg as a denial', async () => {
  const probe = await import('../daemon-client-loopback-probe.ts');
  const denial = { errno: 'EPERM', transport: 'socket', port: 41_234 } as const;
  // "Late" is spent, not faked: the budget is 20 ms and the socket leg answers after 40 ms, so the
  // deadline has provably passed by the time the fallback's answer lands.
  const socketLeg = vi.spyOn(probe, 'probeLoopbackPort').mockImplementation(async () => {
    await sleep(40);
    return { reachable: false, denial };
  });
  const httpLeg = vi.spyOn(probe, 'probeHttpEndpoint').mockResolvedValue({ reachable: true });
  try {
    assert.deepEqual(
      await probeDaemonReachability(
        { token: 'secret', pid: 1, transport: 'dual', port: 41_234, httpPort: 41_235 },
        'auto',
        20,
      ),
      { reachable: false, denial },
    );
  } finally {
    socketLeg.mockRestore();
    httpLeg.mockRestore();
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
    probing = probeDaemonReachability({ token: 'secret', pid: 1, httpPort }, 'http', 40).then(
      (probe) => {
        settled = true;
        return probe.reachable;
      },
    );
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
    const stateDir = mkdtempForTestSync('agent-device-remote-health-cache-');
    const request = (token: string, url = baseUrl) =>
      sendToDaemon(
        {
          command: 'remote-smoke',
          session: 'default',
          positionals: ['ping'],
          flags: { daemonBaseUrl: url, stateDir },
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
      assert.equal(error.details?.reason, DAEMON_UNAVAILABLE_REASONS.remoteUnavailable.reason);
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
    const stateDir = mkdtempForTestSync('agent-device-remote-proxy-health-');
    const request = () =>
      sendToDaemon(
        {
          command: 'remote-smoke',
          session: 'default',
          positionals: ['ping'],
          flags: { daemonBaseUrl: `http://127.0.0.1:${proxyPort}/agent-device/`, stateDir },
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
  const error = await probeDaemonReachability(socketOnly, 'http').then(
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

/** A remote daemon that answers /health with `instanceId()` and refuses a stale instance with 409. */
type RpcAnswer = { status: number; body: unknown };

async function instanceCheckingRemote(
  instanceId: () => string,
  rpcAnswer: () => RpcAnswer | undefined = () => undefined,
) {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/health')) {
      res.end(
        JSON.stringify({ ok: true, service: 'agent-device-daemon', instanceId: instanceId() }),
      );
      return;
    }
    const expected = req.headers[DAEMON_HTTP_INSTANCE_HEADER];
    if (typeof expected === 'string' && expected !== instanceId()) {
      res.statusCode = 409;
      res.setHeader(DAEMON_HTTP_INSTANCE_MISMATCH_HEADER, 'true');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'request', error: { code: -32001 } }));
      return;
    }
    const answer = rpcAnswer() ?? {
      status: 200,
      body: { jsonrpc: '2.0', id: 'request', result: { ok: true, data: {} } },
    };
    res.statusCode = answer.status;
    res.end(JSON.stringify(answer.body));
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(server)}`;
  const stateDir = mkdtempForTestSync('agent-device-remote-health-persisted-');
  const request = () =>
    sendToDaemon(
      {
        command: 'remote-smoke',
        session: 'default',
        positionals: ['ping'],
        flags: { daemonBaseUrl: baseUrl, stateDir },
        meta: { requestId: 'request' },
      },
      { authToken: 'persisted-secret' },
    );
  // What a new CLI process starts with: no health cached in memory, only what the state dir holds.
  const forgetInMemory = () =>
    invalidateRemoteDaemonHealth({ baseUrl, token: 'persisted-secret', pid: 0 });
  const cacheFile = path.join(stateDir, 'remote-daemon-health.json');
  return { server, paths, baseUrl, request, forgetInMemory, cacheFile };
}

// Each CLI call is a new process, so the health a first call probed is kept in the state dir and a
// later process sends straight to /rpc. The instance precondition still catches a replaced daemon.
test('a later process reuses persisted remote health and still catches a replaced daemon', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let instanceId = 'persisted-one';
  const remote = await instanceCheckingRemote(() => instanceId);
  try {
    assert.equal((await remote.request()).ok, true);
    remote.forgetInMemory();
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths, ['GET /health', 'POST /rpc', 'POST /rpc']);

    const persisted = fs.readFileSync(remote.cacheFile, 'utf8');
    assert.equal(persisted.includes('persisted-secret'), false, 'the token is never written');
    assert.equal(persisted.includes(remote.baseUrl), false, 'the URL is never written');
    assert.equal(fs.statSync(remote.cacheFile).mode & 0o077, 0, 'only the owner reads it');

    instanceId = 'persisted-two';
    remote.forgetInMemory();
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths.slice(3), ['POST /rpc', 'GET /health', 'POST /rpc']);
    remote.forgetInMemory();
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths.slice(6), ['POST /rpc'], 'the replacement was persisted');
  } finally {
    await closeLoopbackServer(remote.server);
  }
});

// A send from cached health that never left the process proves nothing reached the daemon, so it
// gets the gate a first contact gets, with the same typed refusal, instead of a bare transport error.
test('an unsent request from cached remote health opens the health gate', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const remote = await instanceCheckingRemote(() => 'gone-soon');
  assert.equal((await remote.request()).ok, true);
  await closeLoopbackServer(remote.server);
  // Lets the client drop its pooled connection, as a new CLI process has none.
  await sleep(20);
  remote.forgetInMemory();
  await assert.rejects(remote.request(), (error: unknown) => {
    assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
    assert.equal(error.details?.reason, DAEMON_UNAVAILABLE_REASONS.remoteUnavailable.reason);
    assert.equal(error.details?.dispatched, 'no');
    return true;
  });
  assert.equal(fs.existsSync(remote.cacheFile), false, 'the unreachable daemon is forgotten');
});

// Resend evidence is only what this process saw: a daemon error that carries the transport-failure
// reason and `daemonRequestSent: false` came over the wire, so the request ran and is not resent.
test('a daemon error that claims the request was unsent is not resent', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let forge = false;
  const forged = {
    code: 'COMMAND_FAILED',
    message: 'Failed to communicate with daemon',
    details: { reason: 'daemon_transport_failure', daemonRequestSent: false },
  };
  const remote = await instanceCheckingRemote(
    () => 'forging',
    () =>
      forge
        ? {
            status: 200,
            body: { jsonrpc: '2.0', id: 'request', error: { code: -32000, data: forged } },
          }
        : undefined,
  );
  try {
    assert.equal((await remote.request()).ok, true);
    remote.forgetInMemory();
    forge = true;
    await assert.rejects(remote.request());
    assert.deepEqual(remote.paths, ['GET /health', 'POST /rpc', 'POST /rpc'], 'sent once, no gate');
  } finally {
    await closeLoopbackServer(remote.server);
  }
});

// A 5xx means the daemon or a hop before it failed, even in valid JSON-RPC framing (a proxy whose
// upstream is restarting answers that way), so the next command probes again. Nothing is resent.
test('a remote 5xx drops the persisted health without a resend', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  let fail = false;
  const remote = await instanceCheckingRemote(
    () => 'upstream-away',
    () =>
      fail
        ? {
            status: 500,
            body: { jsonrpc: '2.0', id: 'request', error: { code: -32000, message: 'upstream' } },
          }
        : undefined,
  );
  try {
    assert.equal((await remote.request()).ok, true);
    fail = true;
    remote.forgetInMemory();
    await assert.rejects(remote.request());
    assert.equal(fs.existsSync(remote.cacheFile), false);
    fail = false;
    assert.equal((await remote.request()).ok, true);
    assert.deepEqual(remote.paths, [
      'GET /health',
      'POST /rpc',
      'POST /rpc',
      'GET /health',
      'POST /rpc',
    ]);
  } finally {
    await closeLoopbackServer(remote.server);
  }
});

// The gate a cached answer skipped runs within what is left of the command's budget, and a caller
// abort while it runs stays the typed cancellation rather than reading as an unreachable daemon.
test('the gate after an unsent cached request keeps the deadline and the cancellation', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const closed = http.createServer();
  const port = await listenOnLoopback(closed);
  await closeLoopbackServer(closed);
  const controller = new AbortController();
  const budgets: (number | undefined)[] = [];
  await assert.rejects(
    sendRequest(
      { token: 'secret', pid: 0, baseUrl: `http://127.0.0.1:${port}` },
      { token: 'secret', command: 'press', session: 'default', positionals: ['@e1'], flags: {} },
      'http',
      resolveDaemonPaths(mkdtempForTestSync('agent-device-remote-gate-abort-')),
      5_000,
      {
        host: createTestHostEnvironment(),
        signal: controller.signal,
        remoteHealthGate: async (budgetMs) => {
          budgets.push(budgetMs);
          controller.abort();
          throw new AppError('COMMAND_FAILED', 'Remote daemon is unavailable', {
            reason: DAEMON_UNAVAILABLE_REASONS.remoteUnavailable.reason,
          });
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AppError, `unexpected failure: ${String(error)}`);
      assert.equal(error.details?.reason, 'request_canceled');
      assert.equal(error.details?.dispatched, 'no');
      return true;
    },
  );
  assert.equal(budgets.length, 1);
  assert.ok(budgets[0]! > 0 && budgets[0]! <= 5_000, `gate budget ${budgets[0]}`);
});

// A transport failure drops the cached health of a remote daemon only: a local daemon has no cached
// health, so its failed request neither invalidates nor loads the remote health cache.
test('a transport failure invalidates cached health for a remote daemon only', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const server = http.createServer((req) => req.socket.destroy());
  const port = await listenOnLoopback(server);
  const invalidate = vi.mocked(invalidateRemoteDaemonHealth);
  invalidate.mockClear();
  const send = (info: Parameters<typeof sendRequest>[0]) =>
    sendRequest(
      info,
      { token: 'secret', command: 'devices', session: 'default', positionals: [], flags: {} },
      'http',
      resolveDaemonPaths('/tmp/agent-device-health-invalidation-test'),
      2_000,
      { host: createTestHostEnvironment(), timeoutRecovery: 'none' },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
  try {
    const local = await send({ token: 'secret', pid: 1, transport: 'http', httpPort: port });
    assert.ok(local instanceof AppError, `unexpected outcome: ${String(local)}`);
    assert.equal(local.details?.reason, 'daemon_transport_failure');
    assert.equal(invalidate.mock.calls.length, 0, 'a local failure leaves the remote cache alone');

    await send({ token: 'secret', pid: 1, baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(invalidate.mock.calls.length, 1);
  } finally {
    await closeLoopbackServer(server);
  }
});
