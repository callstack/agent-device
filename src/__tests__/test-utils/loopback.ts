import http from 'node:http';
import net from 'node:net';

export type LoopbackServer = http.Server | net.Server;
export type SkippableTestContext = {
  skip(reason?: string): void;
};

let loopbackBindSupportPromise: Promise<boolean> | null = null;

function requiresLoopbackCoverage(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.AGENT_DEVICE_REQUIRE_LOOPBACK_TESTS ?? '').toLowerCase(),
  );
}

export async function supportsLoopbackBind(): Promise<boolean> {
  if (loopbackBindSupportPromise) {
    return await loopbackBindSupportPromise;
  }
  loopbackBindSupportPromise = new Promise<boolean>((resolve) => {
    const server = http.createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
  return await loopbackBindSupportPromise;
}

export async function skipWhenLoopbackUnavailable(
  t: SkippableTestContext,
  coverageLabel = 'loopback integration coverage',
): Promise<boolean> {
  if (await supportsLoopbackBind()) {
    return false;
  }
  if (requiresLoopbackCoverage()) {
    throw new Error(`loopback listeners are required for ${coverageLabel}`);
  }
  t.skip('loopback listeners are not permitted in this environment');
  return true;
}

// Connections the test server accepted after it started listening. A `net.Server` refuses to close
// while a connection is live, and a hung-request stand-in keeps one open past the client's RST, so
// teardown destroys them — the job `DaemonServer.destroyConnections` does for the real daemon.
const acceptedConnections = new WeakMap<LoopbackServer, Set<net.Socket>>();

export async function listenOnLoopback(server: LoopbackServer): Promise<number> {
  const sockets = new Set<net.Socket>();
  acceptedConnections.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP server address.');
  }
  return address.port;
}

export async function closeLoopbackServer(server: LoopbackServer): Promise<void> {
  for (const socket of acceptedConnections.get(server) ?? []) {
    socket.destroy();
  }
  acceptedConnections.delete(server);
  if (!server.listening) return;
  closeHttpConnections(server);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeHttpConnections(server: LoopbackServer): void {
  const maybeHttpServer = server as http.Server;
  maybeHttpServer.closeAllConnections?.();
  maybeHttpServer.closeIdleConnections?.();
}

/**
 * `net.Server.close()` waits for every accepted connection to finish, and a request handler that
 * never answers keeps its connection open forever — `http.Server` has `closeAllConnections()` and
 * `net.Server` has no equivalent. Track the accepted sockets so a test whose assertion already
 * failed can destroy them instead of hanging in teardown: a regression in cancellation wiring must
 * surface as the failed assertion, not as the test timeout swallowing it.
 */
export function trackLoopbackSockets(server: net.Server): () => void {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });
  return () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();
  };
}

export function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) < 500) {
          resolve();
          return;
        }
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${url}.`));
        return;
      }
      setTimeout(attempt, 25);
    };
    attempt();
  });
}
