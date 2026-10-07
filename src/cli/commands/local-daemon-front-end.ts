import type net from 'node:net';
import { AppError } from '@agent-device/kernel/errors';
import {
  ensureDaemon,
  resolveClientSettings,
  type DaemonClientSettings,
} from '../../daemon-client/daemon-client-lifecycle.ts';

export type LocalDaemonUpstream = Readonly<{
  upstreamBaseUrl: string;
  upstreamToken: string;
  stateDir: string;
}>;

/**
 * The local HTTP daemon a front-end forwards to over loopback. An empty `daemonBaseUrl` masks
 * `AGENT_DEVICE_DAEMON_BASE_URL`, so a front-end never chains to another remote daemon. Resolving
 * starts nothing, so a front-end can refuse its own configuration before a daemon exists.
 */
export function resolveLocalHttpDaemonSettings(params: {
  command: string;
  stateDir: string | undefined;
}): DaemonClientSettings {
  return resolveClientSettings({
    session: 'default',
    command: params.command,
    positionals: [],
    flags: {
      stateDir: params.stateDir,
      daemonBaseUrl: '',
      daemonTransport: 'http',
      daemonServerMode: 'http',
    },
  });
}

export async function ensureLocalHttpDaemon(
  command: string,
  settings: DaemonClientSettings,
): Promise<LocalDaemonUpstream> {
  const daemon = await ensureDaemon(settings);
  return {
    upstreamBaseUrl: resolveLocalDaemonBaseUrl(command, daemon.info.httpPort),
    upstreamToken: daemon.info.token,
    stateDir: settings.paths.baseDir,
  };
}

function resolveLocalDaemonBaseUrl(command: string, httpPort: number | undefined): string {
  if (!httpPort) {
    throw new AppError('COMMAND_FAILED', 'Local daemon HTTP endpoint is unavailable.', {
      hint: `Retry after cleaning daemon state, or run ${command} with a fresh --state-dir.`,
    });
  }
  return `http://127.0.0.1:${httpPort}`;
}

export async function listenOnTcp(
  server: net.Server,
  host: string,
  port: number,
): Promise<net.AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new AppError('COMMAND_FAILED', 'Server did not bind to a TCP address.');
  }
  return address;
}

export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function waitForever(): Promise<never> {
  return new Promise(() => {});
}
