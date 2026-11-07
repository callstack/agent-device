import net from 'node:net';

import { isCommandTimeoutError, runCmd, runCmdStreaming } from '@agent-device/host-kit/command';
import { Deadline, pollUntilSettled, sleep } from '@agent-device/host-kit/retry';
import { AppError, asAppError, isRequestCanceledError } from '@agent-device/kernel/errors';
import { listTargets, withTunnelRemoval, type PageTunnel } from '@agent-device/tv-cdp';

import { sdbError, type HostEnv } from './tools.ts';

const SDB_PORT = 26101;
// was_kill returns before the app process is gone; a debug launch that races it lands on the
// still-running app and blocks.
const KILL_SETTLE_MS = 2000;
const REMOVE_TIMEOUT_MS = 5000;

export type SdbDevice = Readonly<{
  serial: string;
  state: string;
  model: string;
}>;

export function parseDevices(output: string): SdbDevice[] {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state)
    .map(([serial, state, model]) => ({ serial: serial!, state: state!, model: model ?? '' }));
}

type TizenApp = Readonly<{ id: string; name: string }>;

// `0 vd_applist` prints one block per user app, each field as `--app_title   =Name----`.
export function parseAppList(output: string): TizenApp[] {
  const apps: TizenApp[] = [];
  let title = '';
  for (const line of output.split('\n')) {
    const field = line.match(/^-+([a-z_]+)\s*=(.*?)-+\s*$/);
    if (!field) continue;
    const [, key, raw = ''] = field;
    const value = raw.trim();
    if (key === 'app_id') title = '';
    else if (key === 'app_title') title = value;
    else if (key === 'app_tizen_id' && value) apps.push({ id: value, name: title || value });
  }
  return apps;
}

export const parseDebugPort = (output: string) => {
  const port = Number(output.match(/port:\s*(\d+)/)?.[1]);
  return port || undefined;
};

/** `192.0.2.10` and `192.0.2.10:26101` name the same TV; anything else is taken as a serial. */
export function sdbSerial(device: string): string {
  return /^[\d.]+$/.test(device) ? `${device}:${SDB_PORT}` : device;
}

async function freeLocalPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

type LaunchOptions = Readonly<{ signal?: AbortSignal; timeoutMs?: number; settleMs?: number }>;

/** Removes the forward, then rethrows the error that ended the launch, naming a failed removal. */
async function failAfter(remove: () => Promise<void>, launchError: unknown): Promise<never> {
  try {
    await remove();
  } catch (error) {
    throw withTunnelRemoval(launchError, error);
  }
  throw launchError;
}

export function createSdb(bin: () => string, env: HostEnv) {
  const sdb = async (
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ) => {
    const command = bin();
    try {
      return (await runCmd(command, args, { env, timeoutMs: 60_000, ...options })).stdout;
    } catch (error) {
      throw sdbError(`sdb ${args.filter((arg) => arg !== '-s').join(' ')}`, error);
    }
  };

  const listDevices = async () => parseDevices(await sdb(['devices']));

  const forDevice = (serial: string) => {
    const shell0 = (args: string[], signal?: AbortSignal) =>
      sdb(['-s', serial, 'shell', '0', ...args], { signal });

    // `0 debug` is a launch, not an attach: against a running app it blocks forever with no
    // output, so the caller kills the app first and this bounds the wait.
    async function debugLaunch(appId: string, signal: AbortSignal | undefined, timeoutMs: number) {
      const found = new AbortController();
      let output = '';
      let port: number | undefined;
      const read = (chunk: string) => {
        output += chunk;
        port ??= parseDebugPort(output);
        if (port) found.abort();
      };
      try {
        await runCmdStreaming(bin(), ['-s', serial, 'shell', '0', 'debug', appId], {
          env,
          timeoutMs,
          signal: signal ? AbortSignal.any([signal, found.signal]) : found.signal,
          onStdoutChunk: read,
          onStderrChunk: read,
        });
      } catch (error) {
        if (port) return port;
        if (isCommandTimeoutError(error)) {
          throw new AppError('COMMAND_FAILED', `${appId} gave no debug port in ${timeoutMs}ms`, {
            ...(output.trim() ? { output: output.trim() } : {}),
            hint: output.trim()
              ? `Check that ${appId} is installed with a debug-enabled package.`
              : `${appId} was probably still running. Close it on the TV and retry.`,
          });
        }
        // An app that is not installed makes sdb print `closed` and exit with a failure.
        if (asAppError(error).details?.processExitError !== true) {
          throw sdbError(`sdb debug ${appId}`, error);
        }
      }
      if (port) return port;
      throw new AppError('COMMAND_FAILED', `sdb debug ${appId} exited without a port`, {
        output: output.trim(),
        hint: `Check that ${appId} is installed on the TV.`,
      });
    }

    // A forward lives in the sdb server, not in a child process, so it ends only when removed; a TV
    // that drops off the network shows up as the page socket closing.
    async function forward(remotePort: number, signal: AbortSignal | undefined) {
      const localPort = await freeLocalPort();
      // Removal also runs after a cancel, so it has its own short deadline instead of the request's.
      const remove = async () => {
        await sdb(['-s', serial, 'forward', '--remove', `tcp:${localPort}`], {
          timeoutMs: REMOVE_TIMEOUT_MS,
        });
      };
      try {
        await sdb(['-s', serial, 'forward', `tcp:${localPort}`, `tcp:${remotePort}`], { signal });
      } catch (error) {
        // sdb refused the forward when it exited with a failure; a cancel or timeout may have
        // stopped it after the server made one.
        if (asAppError(error).details?.processExitError === true) throw error;
        return await failAfter(remove, error);
      }
      const listeners: (() => void)[] = [];
      let removal: Promise<void> | undefined;
      const close = () => {
        if (removal) return removal;
        removal = remove();
        for (const listener of listeners) listener();
        return removal;
      };
      return {
        localPort,
        onClose: (listener: () => void) => listeners.push(listener),
        close,
      };
    }

    return {
      serial,

      async kill(appId: string, signal?: AbortSignal) {
        await shell0(['was_kill', appId], signal);
      },

      // A stale forward answers for a dead port, so every launch opens a fresh one.
      async launch(appId: string, options: LaunchOptions = {}): Promise<PageTunnel> {
        const { signal, timeoutMs = 60_000, settleMs = KILL_SETTLE_MS } = options;
        await shell0(['was_kill', appId], signal).catch((error: unknown) => {
          if (isRequestCanceledError(error)) throw error;
        });
        await sleep(settleMs, signal);
        const remotePort = await debugLaunch(appId, signal, timeoutMs);
        const tunnel = await forward(remotePort, signal);
        const { value: target } = await pollUntilSettled({
          deadline: Deadline.fromTimeoutMs(timeoutMs),
          intervalMs: 500,
          signal,
          settled: (found) => found !== undefined,
          probe: async () => (await listTargets(tunnel.localPort, signal).catch(() => []))[0],
        }).catch(async (error: unknown) => await failAfter(tunnel.close, error));
        if (target) return { target, onClose: tunnel.onClose, close: tunnel.close };
        return await failAfter(
          tunnel.close,
          new AppError(
            'COMMAND_FAILED',
            `${appId} opened debug port ${remotePort} but showed no page within ${timeoutMs}ms`,
            { hint: `Retry open ${appId}.` },
          ),
        );
      },

      async listApps(signal?: AbortSignal) {
        return parseAppList(await shell0(['vd_applist'], signal));
      },
    };
  };

  return {
    listDevices,
    async connect(serial: string) {
      await sdb(['connect', serial], { timeoutMs: 30_000 });
    },
    forDevice,
  };
}
