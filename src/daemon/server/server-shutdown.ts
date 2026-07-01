import type { DaemonServer } from './transport.ts';

const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;

function forceCloseServer(server: DaemonServer): void {
  server.destroyConnections?.();
  const closeAllConnections =
    'closeAllConnections' in server ? server.closeAllConnections : undefined;
  if (typeof closeAllConnections === 'function') {
    closeAllConnections.call(server);
    return;
  }
  const closeIdleConnections =
    'closeIdleConnections' in server ? server.closeIdleConnections : undefined;
  if (typeof closeIdleConnections === 'function') closeIdleConnections.call(server);
}

export async function closeDaemonServers(
  servers: DaemonServer[],
  timeoutMs: number = DAEMON_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(
    servers.map(async (server) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        timeoutHandle = setTimeout(() => {
          forceCloseServer(server);
          resolve();
        }, timeoutMs);
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }),
  );
}
