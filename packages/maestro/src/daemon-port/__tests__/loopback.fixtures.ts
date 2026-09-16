import http from 'node:http';
import net from 'node:net';

type LoopbackServer = http.Server | net.Server;
type SkippableTestContext = {
  skip(reason?: string): void;
};

let loopbackBindSupportPromise: Promise<boolean> | null = null;

function requiresLoopbackCoverage(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    (process.env.AGENT_DEVICE_REQUIRE_LOOPBACK_TESTS ?? '').toLowerCase(),
  );
}

async function supportsLoopbackBind(): Promise<boolean> {
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

export async function listenOnLoopback(server: LoopbackServer): Promise<number> {
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
  if (!server.listening) return;
  const maybeHttpServer = server as http.Server;
  maybeHttpServer.closeAllConnections?.();
  maybeHttpServer.closeIdleConnections?.();
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
