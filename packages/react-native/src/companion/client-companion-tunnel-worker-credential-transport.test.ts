// The companion's bearer token and its bridge socket URL never leave this machine in cleartext: not
// to a plain destination off loopback, and not through an environment proxy.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dns from 'node:dns';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, test, vi } from 'vitest';
import { isCredentialTransportRefusal } from '@agent-device/contracts/credential-transport';
import { closeLoopbackServer, listenOnLoopback, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  ENV_COMPANION_TUNNEL_BEARER_TOKEN,
  ENV_COMPANION_TUNNEL_LOCAL_BASE_URL,
  ENV_COMPANION_TUNNEL_REGISTER_PATH,
  ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID,
  ENV_COMPANION_TUNNEL_SCOPE_RUN_ID,
  ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID,
  ENV_COMPANION_TUNNEL_SERVER_BASE_URL,
  METRO_COMPANION_RUN_ARG,
} from './client-companion-tunnel-contract.ts';
import {
  acceptWebSocketUpgrade,
  attachWebSocketFrameParser,
  encodeTextFrame,
} from './client-companion-tunnel-worker.fixtures.ts';
import { runCompanionTunnelWorker } from './client-companion-tunnel-worker.ts';

const REGISTER_PATH = '/api/metro/companion/register';
const UNREGISTER_PATH = '/api/metro/companion/unregister';

const cleanupTasks: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) await cleanupTasks.pop()!();
  vi.restoreAllMocks();
});

/** Runs the worker in process; `done` settles when it exits, and `stop` ends its lease first. */
function startWorker(serverBaseUrl: string, localBaseUrl = 'http://127.0.0.1:1') {
  const statePath = path.join(mkdtempForTestSync('metro-companion-transport-'), 'state.json');
  fs.writeFileSync(statePath, '{}');
  const done = runCompanionTunnelWorker(
    {
      serverBaseUrl,
      bearerToken: 'test-token',
      localBaseUrl,
      registerPath: REGISTER_PATH,
      unregisterPath: UNREGISTER_PATH,
      bridgeScope: { tenantId: 'tenant-1', runId: 'run-1', leaseId: 'lease-1' },
      statePath,
    },
    { leaseCheckIntervalMs: 25, reconnectDelayMs: 25 },
  );
  const stop = async () => {
    fs.rmSync(statePath, { force: true });
    await done.catch(() => undefined);
  };
  cleanupTasks.push(stop);
  return { done, stop };
}

/**
 * A socket taken from an HTTP server on `upgrade` or `connect` has no `error` listener left, and a
 * peer that dies with it open can reset it. These cases judge what arrived, not how it closed.
 */
function tolerateReset(socket: Duplex): void {
  socket.on('error', () => undefined);
}

/** Where a registration path moved: a constant, never a value taken from the request. */
function movedTo(path: string | undefined): string | undefined {
  if (path === REGISTER_PATH) return `${REGISTER_PATH}/moved`;
  if (path === UNREGISTER_PATH) return `${UNREGISTER_PATH}/moved`;
  return undefined;
}

/**
 * A loopback bridge whose registration answers `wsUrl(port)`, recording what reaches it and what
 * the companion sends on the socket. `moved` redirects each registration path once.
 */
async function listenBridge(wsUrl: (port: number) => string, moved = false) {
  const received: string[] = [];
  let upgrade!: (socket: Duplex) => void;
  const upgraded = new Promise<Duplex>((resolve) => (upgrade = resolve));
  let port = 0;
  let socketRef: Duplex | undefined;
  const replies: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.url} ${req.headers.authorization}`);
    req.resume();
    const location = moved ? movedTo(req.url) : undefined;
    if (location) {
      res.writeHead(307, { location }).end();
      return;
    }
    res.end(JSON.stringify({ ok: true, data: { ws_url: wsUrl(port) } }));
  });
  server.on('upgrade', (req, socket) => {
    tolerateReset(socket);
    received.push(`UPGRADE ${req.url}`);
    socketRef = socket;
    if (!acceptWebSocketUpgrade(req, socket)) return;
    attachWebSocketFrameParser(socket, (text) => replies.push(JSON.parse(text)));
    upgrade(socket);
  });
  cleanupTasks.push(() => closeLoopbackServer(server));
  cleanupTasks.push(async () => socketRef?.destroy());
  port = await listenOnLoopback(server);
  /** Sends one tunnel message and waits for the companion's answer to it. */
  const relay = async (message: Record<string, unknown>) => {
    const answered = replies.length;
    (await upgraded).write(encodeTextFrame(JSON.stringify(message)));
    await vi.waitFor(() => assert.ok(replies.length > answered));
    return replies[answered]!;
  };
  return { origin: `http://127.0.0.1:${port}`, received, upgraded, relay };
}

const registered = `${REGISTER_PATH} Bearer test-token`;
const unregistered = `${UNREGISTER_PATH} Bearer test-token`;

// A base without a host gains one from the appended path: `https://` would reach `https://api/...`.
test.for(['http://bridge.invalid', 'http:', 'https://', 'https:'])(
  'the worker never sends its bearer token to %s and exits',
  async (serverBaseUrl) => {
    const sent: unknown[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      sent.push(input);
      return new Response(null, { status: 401 });
    });
    vi.spyOn(http, 'request').mockImplementation(((target: unknown) => {
      sent.push(target);
      throw new Error('nothing may be sent');
    }) as typeof http.request);

    await assert.rejects(startWorker(serverBaseUrl).done, isCredentialTransportRefusal);

    assert.deepEqual(sent, []);
  },
);

test('the worker reaches a loopback bridge directly, never through global fetch', async () => {
  const bridge = await listenBridge((port) => `ws://127.0.0.1:${port}/bridge`);
  const proxied = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('proxied'));
  const worker = startWorker(bridge.origin);

  (await bridge.upgraded).destroy();
  await worker.stop();

  assert.equal(bridge.received[0], registered);
  assert.ok(bridge.received.includes(unregistered), `${bridge.received}`);
  assert.equal(proxied.mock.calls.length, 0);
});

/** A TCP listener that records every connection, whatever protocol its caller speaks. */
async function listenSink() {
  const connections: unknown[] = [];
  const server = net.createServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanupTasks.push(() => new Promise((resolve) => server.close(resolve)));
  return { port: (server.address() as AddressInfo).port, connections };
}

// `0.0.0.0` reaches this machine's listener and is not a loopback address, so a socket opened
// without the check would show up at the sink. So would `http` or `https` on loopback, which a
// `WebSocket` accepts.
test.for([
  (port: number) => `ws://0.0.0.0:${port}/bridge?ticket=secret`,
  (port: number) => `ws://0.0.0.0:${port}/bridge`,
  (port: number) => `http://127.0.0.1:${port}/bridge?ticket=secret`,
  (port: number) => `https://127.0.0.1:${port}/bridge`,
])('the worker refuses any socket but wss or loopback ws before it opens', async (wsUrl) => {
  const sink = await listenSink();
  const bridge = await listenBridge(() => wsUrl(sink.port));

  await assert.rejects(startWorker(bridge.origin).done, isCredentialTransportRefusal);

  assert.deepEqual(sink.connections, []);
  assert.deepEqual(bridge.received, [registered, unregistered]);
});

/** Runs the worker as its own process against `origin`, with `env` over this one's. */
function spawnWorker(origin: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(import.meta.dirname, 'companion-tunnel.ts'),
      METRO_COMPANION_RUN_ARG,
    ],
    {
      env: {
        ...process.env,
        [ENV_COMPANION_TUNNEL_SERVER_BASE_URL]: origin,
        [ENV_COMPANION_TUNNEL_BEARER_TOKEN]: 'test-token',
        [ENV_COMPANION_TUNNEL_LOCAL_BASE_URL]: 'http://127.0.0.1:1',
        [ENV_COMPANION_TUNNEL_REGISTER_PATH]: REGISTER_PATH,
        [ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID]: 'tenant-1',
        [ENV_COMPANION_TUNNEL_SCOPE_RUN_ID]: 'run-1',
        [ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID]: 'lease-1',
        ...env,
      },
      stdio: 'ignore',
    },
  );
  const exited = once(child, 'exit');
  cleanupTasks.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });
  return exited;
}

test('the worker opens a loopback socket around an environment proxy', async () => {
  const proxied: string[] = [];
  const proxy = http.createServer((req, res) => {
    proxied.push(`${req.method} ${req.url}`);
    res.writeHead(502).end();
  });
  for (const event of ['upgrade', 'connect'] as const) {
    proxy.on(event, (req: http.IncomingMessage, socket: Duplex) => {
      tolerateReset(socket);
      proxied.push(`${event} ${req.url}`);
      socket.destroy();
    });
  }
  cleanupTasks.push(() => closeLoopbackServer(proxy));
  const proxyUrl = `http://127.0.0.1:${await listenOnLoopback(proxy)}`;
  const bridge = await listenBridge((port) => `ws://127.0.0.1:${port}/bridge?ticket=secret`);

  // Node reads `NODE_USE_ENV_PROXY` at startup, so this worker runs as its own process.
  const exited = spawnWorker(bridge.origin, {
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: '',
    no_proxy: '',
  });

  await Promise.race([
    bridge.upgraded,
    exited.then(() => assert.fail('the worker exited before it opened the bridge socket')),
  ]);

  assert.deepEqual(bridge.received, [registered, 'UPGRADE /bridge?ticket=secret']);
  assert.deepEqual(proxied, []);
});

test('a refused socket URL ends the worker process as failed', async () => {
  const bridge = await listenBridge(() => 'ws://0.0.0.0:1/bridge');

  const [exitCode] = await spawnWorker(bridge.origin);

  assert.equal(exitCode, 1);
  assert.deepEqual(bridge.received, [registered]);
});

test('a bridge socket on a localhost that resolves off loopback never opens', async () => {
  const bridge = await listenBridge((port) => `ws://localhost:${port}/bridge?ticket=secret`);
  // `0.0.0.0` reaches this machine's listener and is not a loopback address.
  vi.spyOn(dns, 'lookup').mockImplementation(((
    _hostname: string,
    options: dns.LookupOptions,
    callback: (...answer: unknown[]) => void,
  ) => {
    if (options.all) callback(null, [{ address: '0.0.0.0', family: 4 }]);
    else callback(null, '0.0.0.0', 4);
  }) as typeof dns.lookup);

  await assert.rejects(startWorker(bridge.origin).done, isCredentialTransportRefusal);

  assert.deepEqual(bridge.received, [registered, unregistered]);
});

test('registration and unregistration follow a same-origin redirect with the token', async () => {
  const bridge = await listenBridge((port) => `ws://127.0.0.1:${port}/bridge`, true);
  const worker = startWorker(bridge.origin);

  (await bridge.upgraded).destroy();
  await worker.stop();

  for (const path of [REGISTER_PATH, UNREGISTER_PATH]) {
    assert.ok(bridge.received.includes(`${path}/moved Bearer test-token`), `${bridge.received}`);
  }
});

/** A server recording the credential headers of each request that reaches it. */
async function listenLocalServer(location?: () => string) {
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    received.push(`${req.url} ${req.headers.authorization ?? req.headers.cookie ?? '-'}`);
    req.resume();
    if (location && req.url === '/redirect') res.writeHead(307, { location: location() }).end();
    else res.end('bundle');
  });
  cleanupTasks.push(() => closeLoopbackServer(server));
  const port = await listenOnLoopback(server);
  return { port, origin: `http://127.0.0.1:${port}`, received };
}

/** Starts a worker for `localBaseUrl` and returns the bridge that relays to it. */
async function relayingBridge(localBaseUrl: string) {
  const bridge = await listenBridge((port) => `ws://127.0.0.1:${port}/bridge`);
  startWorker(bridge.origin, localBaseUrl);
  await bridge.upgraded;
  return bridge;
}

const httpRequest = (path: string, headers: Record<string, string> = {}) => ({
  type: 'http-request',
  requestId: 'request-1',
  method: 'GET',
  path,
  headers,
});

test('a relayed path that leaves the local base URL is refused, over HTTP and sockets', async () => {
  const local = await listenLocalServer();
  const other = await listenLocalServer();
  const bridge = await relayingBridge(local.origin);

  for (const path of [`${other.origin}/steal`, `//127.0.0.1:${other.port}/steal`]) {
    const answer = await bridge.relay(httpRequest(path, { authorization: 'Bearer app' }));
    assert.equal(answer.type, 'http-error', path);
    const opened = await bridge.relay({ type: 'ws-open', streamId: 'stream-1', path });
    assert.equal(opened.success, false, path);
  }

  assert.deepEqual([local.received, other.received], [[], []]);
});

test.each([
  ['authorization', 'Bearer app'],
  ['cookie', 'session=app'],
])('a relayed %s never goes over plain http off loopback', async (name, value) => {
  const local = await listenLocalServer();
  // Reaches this machine's listener without being a loopback address, as a LAN dev server would.
  const bridge = await relayingBridge(`http://0.0.0.0:${local.port}`);

  const refusedAnswer = await bridge.relay(httpRequest('/secret', { [name]: value }));
  const openAnswer = await bridge.relay(httpRequest('/index.bundle'));

  assert.equal(refusedAnswer.type, 'http-error');
  assert.equal(openAnswer.status, 200);
  assert.deepEqual(local.received, ['/index.bundle -']);
});

test('a relayed credential reaches loopback directly and stays on its origin', async () => {
  const other = await listenLocalServer();
  const local = await listenLocalServer(() => `http://0.0.0.0:${other.port}/redirected`);
  const bridge = await relayingBridge(local.origin);
  const proxied = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('proxied'));

  const direct = await bridge.relay(httpRequest('/secret', { cookie: 'session=app' }));
  const redirected = await bridge.relay(httpRequest('/redirect', { cookie: 'session=app' }));

  assert.equal(direct.status, 200);
  assert.equal(redirected.status, 307);
  assert.deepEqual(local.received, ['/secret session=app', '/redirect session=app']);
  assert.deepEqual(other.received, []);
  assert.equal(proxied.mock.calls.length, 0);
});
