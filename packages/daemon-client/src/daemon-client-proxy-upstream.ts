import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  ensureStartedDaemon,
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
  // `proxy` owns the local daemon it forwards to: it starts a missing one and may retire a startup
  // contender it cannot use. A client request never takes this path.
  const settings = {
    ...resolveClientSettings(
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
    ),
    retireIncompatibleContender: true,
    ...(options.onTakeover ? { onTakeover: options.onTakeover } : {}),
  };
  const daemon = await ensureStartedDaemon(settings);
  return {
    httpPort: daemon.info.httpPort,
    token: daemon.info.token,
    stateDir: settings.paths.baseDir,
  };
}
