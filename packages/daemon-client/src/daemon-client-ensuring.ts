import type { DaemonIdentity, EnsureDaemonOptions } from '@agent-device/contracts/client';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { captureHostEnvironment } from '@agent-device/host-kit/environment';
import { createStartupWaitGuard } from './daemon-client-transport.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import type { DaemonTransport } from './daemon-client-request.ts';
import { isDaemonNotRunningError } from './daemon-lifecycle-errors.ts';

export type EnsuringTransportOptions = {
  /** The host the ensured daemon is resolved and started from; the process's own when omitted. */
  host?: HostEnvironment;
  /** Controls local daemon startup and the request's final transport handoff. */
  admit?: <T>(
    start: () => Promise<T>,
    phase: 'startup' | 'dispatch',
    req: Parameters<DaemonTransport>[0],
  ) => Promise<T>;
  /**
   * Called when ensuring replaced a daemon: an `incompatible` one that held no work, or an
   * `unreachable` one that answered nothing.
   */
  onReplaced?: (replaced: {
    stateDir: string;
    previous: DaemonIdentity;
    reason: 'incompatible' | 'unreachable';
  }) => void;
};

/**
 * Makes a transport explicit about the daemon: the first request that needs a local daemon calls
 * `ensureDaemon`, and every request then attaches to what it left. The CLI and MCP use this, so
 * neither starts a daemon implicitly nor replaces one that holds another client's work.
 *
 * Ensuring waits for the first request rather than the first call, so a command that never reaches
 * the daemon starts none. A remote connection, and a one-shot replay on its own private daemon, pass
 * through untouched: neither has a shared local daemon to ensure.
 *
 * A request that attaches to a daemon that has since gone ensures it again and runs once more; it
 * never reached a daemon, so nothing can run twice.
 */
export function withEnsuredDaemon(
  transport: DaemonTransport,
  options: EnsuringTransportOptions = {},
): DaemonTransport {
  const ensured = new Map<string, Promise<unknown>>();
  return async (req, context) => {
    // Loaded on the first request: the lifecycle module is not part of what every CLI start pays for.
    const { resolveEnsurableDaemon } = await import('./daemon-client-lifecycle.ts');
    const host = options.host ?? captureHostEnvironment(process);
    const { admit } = options;
    const transportContext: Parameters<DaemonTransport>[1] = admit
      ? { ...context, dispatch: (send) => admit(send, 'dispatch', req) }
      : context;
    const target = resolveEnsurableDaemon(req, host);
    if (!target) {
      if (admit) {
        const guard = createStartupWaitGuard({
          signal: context?.signal,
          requestId: req.meta?.requestId,
        });
        await guard.guard(() => admit(async () => guard.refuseIfAborted(), 'startup', req));
      }
      return await transport(req, transportContext);
    }
    const stateDir = resolveDaemonPaths(target.stateDir, { env: host.env, cwd: host.cwd }).baseDir;
    // A caller that has already given up starts nothing: attaching refuses before any connection.
    if (context?.signal?.aborted) {
      return await transport(req, context);
    }
    const admissionGuard = createStartupWaitGuard({
      signal: context?.signal,
      requestId: req.meta?.requestId,
    });
    // A finished ensure is kept for the rest of this transport's life. A rejected one is dropped so
    // the next request retries, and one whose daemon has since gone is dropped by the attach below.
    const ensure = async (): Promise<{ relied: Promise<unknown> }> => {
      admissionGuard.refuseIfAborted();
      let pending = ensured.get(stateDir);
      if (!pending) {
        const started = ensureLocalDaemon(target, stateDir, host, options);
        pending = started;
        ensured.set(stateDir, started);
        started.catch(() => {
          if (ensured.get(stateDir) === started) ensured.delete(stateDir);
        });
      }
      await pending;
      return { relied: pending };
    };
    // Cancellation ends the caller's wait. A startup already in progress must finish before
    // admission releases the connection lock.
    const admitAndEnsure = () =>
      admissionGuard.guard(() => (admit ? admit(ensure, 'startup', req) : ensure()));
    const { relied } = await admitAndEnsure();
    const attach = async () => await transport(req, transportContext);
    try {
      return await attach();
    } catch (error) {
      // The daemon this invocation ensured is gone (idle reap, a crash, another client's stop).
      // An attach that finds none sent nothing, so ensuring again and sending once is safe.
      if (!isDaemonNotRunningError(error)) throw error;
      // Only the promise this attach relied on is dropped: a concurrent request may already have
      // replaced it with a fresh one.
      if (ensured.get(stateDir) === relied) ensured.delete(stateDir);
      await admitAndEnsure();
      return await attach();
    }
  };
}

async function ensureLocalDaemon(
  target: EnsureDaemonOptions,
  stateDir: string,
  host: HostEnvironment,
  options: EnsuringTransportOptions,
): Promise<void> {
  const { ensureDaemon } = await import('./daemon-client-ensure.ts');
  await ensureDaemon(
    {
      ...target,
      onStart: (reason, previous) => {
        if (previous) {
          options.onReplaced?.({
            stateDir,
            previous,
            reason: reason === 'incompatible' ? 'incompatible' : 'unreachable',
          });
        }
      },
    },
    host,
  );
}
