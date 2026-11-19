import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  ensureManagedDaemon,
  resolveClientSettings,
  type DaemonTakeoverNotice,
} from './daemon-client-lifecycle.ts';

export type ProxyUpstreamDaemonOptions = {
  stateDir?: string;
  host: HostEnvironment;
  /** Told when ensuring retires an incompatible daemon; the CLI renders it. */
  onTakeover?: (notice: DaemonTakeoverNotice) => void;
};

export type ProxyUpstreamDaemon = {
  httpPort: number | undefined;
  token: string;
  stateDir: string;
};

export async function ensureProxyUpstreamDaemon(
  options: ProxyUpstreamDaemonOptions,
): Promise<ProxyUpstreamDaemon> {
  const settings = resolveClientSettings(
    {
      session: 'default',
      command: 'proxy',
      positionals: [],
      flags: {
        stateDir: options.stateDir,
        daemonBaseUrl: '',
        daemonTransport: 'http',
        daemonServerMode: 'http',
      },
    },
    undefined,
    options.host,
  );
  const daemon = await ensureManagedDaemon(
    options.onTakeover ? { ...settings, onTakeover: options.onTakeover } : settings,
  );
  return {
    httpPort: daemon.info.httpPort,
    token: daemon.info.token,
    stateDir: settings.paths.baseDir,
  };
}
