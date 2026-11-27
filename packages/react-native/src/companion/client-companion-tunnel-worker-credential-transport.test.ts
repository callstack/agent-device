// The companion's bearer token and its bridge socket URL never leave this machine in cleartext: not
// to a plain destination off loopback, and not through an environment proxy.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { afterEach, test, vi } from 'vitest';
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
import { acceptWebSocketUpgrade } from './client-companion-tunnel-worker.fixtures.ts';
import { runCompanionTunnelWorker } from './client-companion-tunnel-worker.ts';

const REGISTER_PATH = '/api/metro/companion/register';
const UNREGISTER_PATH = '/api/metro/companion/unregister';

const cleanupTasks: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) await cleanupTasks.pop()!();
  vi.restoreAllMocks();
});

/** Runs the worker in process; `done` resolves when it exits, and `stop` ends its lease first. */
function startWorker(serverBaseUrl: string) {
  const statePath = path.join(mkdtempForTestSync('metro-companion-transport-'), 'state.json');
  fs.writeFileSync(statePath, '{}');
  const done = runCompanionTunnelWorker(
    {
      serverBaseUrl,
      bearerToken: 'test-token',
      localBaseUrl: 'http://127.0.0.1:1',
      registerPath: REGISTER_PATH,
      unregisterPath: UNREGISTER_PATH,
      bridgeScope: { tenantId: 'tenant-1', runId: 'run-1', leaseId: 'lease-1' },
      statePath,
    },
    { leaseCheckIntervalMs: 25, reconnectDelayMs: 25 },
  );
  const stop = async () => {
    fs.rmSync(statePath, { force: true });
    await done;
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

/** A loopback bridge whose registration answers `wsUrl(port)`, recording what reaches it. */
async function listenBridge(wsUrl: (port: number) => string) {
  const received: string[] = [];
  let upgrade!: (socket: Duplex) => void;
  const upgraded = new Promise<Duplex>((resolve) => (upgrade = resolve));
  let port = 0;
  let socketRef: Duplex | undefined;
  const server = http.createServer((req, res) => {
    received.push(`${req.url} ${req.headers.authorization}`);
    req.resume();
    res.end(JSON.stringify({ ok: true, data: { ws_url: wsUrl(port) } }));
  });
  server.on('upgrade', (req, socket) => {
    tolerateReset(socket);
    received.push(`UPGRADE ${req.url}`);
    socketRef = socket;
    if (acceptWebSocketUpgrade(req, socket)) upgrade(socket);
  });
  cleanupTasks.push(() => closeLoopbackServer(server));
  cleanupTasks.push(async () => socketRef?.destroy());
  port = await listenOnLoopback(server);
  return { origin: `http://127.0.0.1:${port}`, received, upgraded };
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

    await startWorker(serverBaseUrl).done;

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

  await startWorker(bridge.origin).done;

  assert.deepEqual(sink.connections, []);
  assert.deepEqual(bridge.received, [registered, unregistered]);
});

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
        [ENV_COMPANION_TUNNEL_SERVER_BASE_URL]: bridge.origin,
        [ENV_COMPANION_TUNNEL_BEARER_TOKEN]: 'test-token',
        [ENV_COMPANION_TUNNEL_LOCAL_BASE_URL]: 'http://127.0.0.1:1',
        [ENV_COMPANION_TUNNEL_REGISTER_PATH]: REGISTER_PATH,
        [ENV_COMPANION_TUNNEL_SCOPE_TENANT_ID]: 'tenant-1',
        [ENV_COMPANION_TUNNEL_SCOPE_RUN_ID]: 'run-1',
        [ENV_COMPANION_TUNNEL_SCOPE_LEASE_ID]: 'lease-1',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        NO_PROXY: '',
        no_proxy: '',
      },
      stdio: 'ignore',
    },
  );
  const exited = once(child, 'exit');
  cleanupTasks.push(async () => {
    child.kill('SIGKILL');
    await exited;
  });

  await Promise.race([
    bridge.upgraded,
    exited.then(() => assert.fail('the worker exited before it opened the bridge socket')),
  ]);

  assert.deepEqual(bridge.received, [registered, 'UPGRADE /bridge?ticket=secret']);
  assert.deepEqual(proxied, []);
});
