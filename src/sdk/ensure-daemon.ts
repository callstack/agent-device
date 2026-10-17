import type { DaemonConnection, EnsureDaemonOptions } from '@agent-device/contracts/client';

/**
 * Starts the local daemon on a state directory if none is usable, and replaces an incompatible one
 * only when it holds no request, session, repair session or live lease. See `DaemonLifecycle`.
 *
 * Loaded on first call: a client that only attaches never pays for the startup and replacement
 * machinery.
 */
export async function ensureDaemon(options?: EnsureDaemonOptions): Promise<DaemonConnection> {
  const { ensureDaemon: ensure } = await import('../daemon-client/daemon-client-ensure.ts');
  return await ensure(options);
}
