import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import { normalizeError, type NormalizedError } from '@agent-device/kernel/errors';
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

/** What a closed daemon runtime leaves behind, by kind of resource. */
export type ShutdownReport = {
  /** Provider lease releases, by lease id. `unknown` was still in flight when the budget ran out. */
  providerReleases: { completed: string[]; pending: string[]; unknown: string[] };
  /** Device runners, by device id: `handedOff` was left running for the next daemon. */
  runners: { stopped: string[]; handedOff: string[] };
  sessions: { closed: number; failed: number };
  plugins: { disposed: string[]; failed: { provider: string; error: NormalizedError }[] };
};

export type ProviderRuntimeDisposal = Readonly<{
  /** Disposes every provider runtime once; later calls return the first call's result. */
  dispose(): Promise<ShutdownReport['plugins']>;
}>;

export function createProviderRuntimeDisposal(
  runtimes: readonly Pick<ProviderDeviceRuntime, 'provider' | 'shutdown'>[],
): ProviderRuntimeDisposal {
  let disposal: Promise<ShutdownReport['plugins']> | undefined;
  return {
    dispose: () =>
      (disposal ??= (async () => {
        const report: ShutdownReport['plugins'] = { disposed: [], failed: [] };
        await Promise.all(
          runtimes.map(async (runtime) => {
            try {
              await runtime.shutdown();
              report.disposed.push(runtime.provider);
            } catch (error) {
              report.failed.push({ provider: runtime.provider, error: normalizeError(error) });
            }
          }),
        );
        return report;
      })()),
  };
}

/** Undoes startup work in reverse order; a step that throws never stops the ones before it. */
export type StartupRollback = Readonly<{
  onRollback(step: () => Promise<void> | void): void;
  run(): Promise<void>;
}>;

export function createStartupRollback(): StartupRollback {
  const steps: Array<() => Promise<void> | void> = [];
  return {
    onRollback: (step) => {
      steps.push(step);
    },
    run: async () => {
      for (const step of steps.splice(0).reverse()) {
        await Promise.resolve()
          .then(step)
          .catch(() => {});
      }
    },
  };
}
