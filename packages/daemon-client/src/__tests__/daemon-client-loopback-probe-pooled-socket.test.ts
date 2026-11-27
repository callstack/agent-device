import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { afterEach, test, vi, type Mock } from 'vitest';
import {
  closeLoopbackServer,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import * as hostTransport from '@agent-device/host-kit/transport';
import { probeDaemonReachability } from '../daemon-client-transport.ts';

// A reachability probe must not be answered around by a keep-alive socket an earlier command left in
// the pool: a caller reads this verdict before it retires a daemon, and a pooled socket proves only
// that SOME connect was allowed at SOME point, not that one is allowed NOW.
//
// This case owns a file because it patches `Socket.prototype.connect` for every socket made while the
// patch is on and leans on the process-wide keep-alive pool. Vitest gives each file a worker of its
// own, so the refusal cannot reach a case elsewhere that is mid-request on a shared socket, and
// `afterEach` hands the prototype back before this file runs anything else.

let server: http.Server | undefined;
let connect: Mock<net.Socket['connect']> | undefined;
const askedUrls: string[] = [];

afterEach(async () => {
  connect?.mockRestore();
  connect = undefined;
  askedUrls.length = 0;
  if (server) await closeLoopbackServer(server);
  server = undefined;
});

test('a fresh connect the host refused is not answered around by a pooled socket', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  server = http.createServer((req, res) => {
    askedUrls.push(String(req.url));
    res.end('{}');
  });
  const port = await listenOnLoopback(server);
  // The pool may still hold a socket for THIS port from a server this worker already closed, and the
  // OS hands loopback ports out again. Riding one would write the prime to a peer that never answers,
  // so this endpoint's pooled sockets go first.
  destroyPooledSockets(http.globalAgent, port);

  // Prime the pool the way an earlier command primes it: one health request whose socket returns to
  // the agent. It goes through the SAME module object the probe loads, or no candidate lands in the
  // pool and the case proves nothing. The request is bounded so a pool this case does not control
  // cannot hold it open to the test budget.
  const requester = await hostTransport.loadNodeHttpRequester(new URL('http://127.0.0.1'));
  await new Promise<void>((resolve, reject) => {
    const request = requester.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 2_000 },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    request.on('timeout', () => {
      request.destroy(new Error(`the prime reached no daemon on port ${port}`));
    });
    request.on('error', reject);
    request.end();
  });
  // A pool that took nothing in would leave the probe with nothing to ride, and a `reachable: false`
  // verdict would then mean nothing.
  assert.ok(
    freeSocketCountFor(http.globalAgent, port) > 0,
    'the prime left a keep-alive socket in the pool for this endpoint',
  );

  // A host that refuses a connect answers it immediately, with no round trip: the socket ends with
  // the errno and carries no request. The connect is the real one, so the socket has a handle and the
  // errno reaches the requester — destroying a socket that never connected reports only a closed
  // socket. The refusal lands on a later turn, after the requester has put its listener on it.
  const realConnect = net.Socket.prototype.connect;
  connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: Parameters<net.Socket['connect']>
  ) {
    const socket = realConnect.apply(this, args as never) as net.Socket;
    setImmediate(() => socket.destroy(Object.assign(new Error('EPERM'), { code: 'EPERM' })));
    return socket;
  });

  assert.deepEqual(
    await probeDaemonReachability({ token: 'secret', pid: 1, httpPort: port }, 'http'),
    { reachable: false, denial: { errno: 'EPERM', transport: 'http', port } },
  );
  assert.deepEqual(askedUrls, ['/health'], 'only the prime reached the daemon');

  // The primed socket is back in the pool now, pointed at a server about to close. Drop this
  // endpoint's entry so nothing downstream rides it.
  destroyPooledSockets(http.globalAgent, port);
});

/** Drops the keep-alive sockets the pool holds for one loopback port, and only those. */
function destroyPooledSockets(agent: http.Agent, port: number): void {
  // Node types the pool as read-only, and this is the one place a test has to empty it.
  const free = agent.freeSockets as Record<string, net.Socket[] | undefined>;
  for (const [key, sockets] of Object.entries(free)) {
    if (!isPooledEndpointForPort(key, port)) continue;
    for (const socket of sockets ?? []) socket.destroy();
    delete free[key];
  }
}

/** How many idle keep-alive sockets the pool holds for one loopback port. */
function freeSocketCountFor(agent: http.Agent, port: number): number {
  return Object.entries(agent.freeSockets).reduce(
    (total, [key, sockets]) =>
      isPooledEndpointForPort(key, port) ? total + (sockets?.length ?? 0) : total,
    0,
  );
}

/** The agent keys sockets by `host:port:`; the port is the field before the trailing colon. */
function isPooledEndpointForPort(key: string, port: number): boolean {
  const [, pooledPort] = key.split(':');
  return Number(pooledPort) === port;
}
