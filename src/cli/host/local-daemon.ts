import type net from 'node:net';
import type { CliFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { colorize } from '../../commands/output/color.ts';
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
 * The local HTTP daemon Host forwards to over loopback. An empty `daemonBaseUrl` masks
 * `AGENT_DEVICE_DAEMON_BASE_URL`, so Host never chains to another remote daemon. Resolving
 * starts nothing, so Host can refuse its own configuration before a daemon exists.
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

/** The bind address `--host`/`--port` name; loopback and a free port by default. */
export function resolveBindAddress(flags: Pick<CliFlags, 'proxyHost' | 'proxyPort'>): {
  host: string;
  port: number;
} {
  return { host: flags.proxyHost?.trim() || '127.0.0.1', port: flags.proxyPort ?? 0 };
}

export async function listenOnTcp(
  server: net.Server,
  bind: { host: string; port: number },
): Promise<net.AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(bind.port, bind.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new AppError('COMMAND_FAILED', 'Host did not bind to a TCP address.');
  }
  return address;
}

export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function formatOutputValue(
  value: string,
  format: Parameters<typeof colorize>[1],
  useColor: boolean,
): string {
  return useColor ? colorize(value, format, { validateStream: false }) : value;
}

export function waitForever(): Promise<never> {
  return new Promise(() => {});
}
