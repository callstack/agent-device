import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { ensureManagedDaemon, resolveClientSettings } from './daemon-client-lifecycle.ts';

export type ProxyUpstreamDaemon = Readonly<{
  httpPort: number | undefined;
  token: string;
  stateDir: string;
}>;

export async function ensureProxyUpstreamDaemon(options: {
  stateDir?: string;
  host: HostEnvironment;
}): Promise<ProxyUpstreamDaemon> {
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
  const daemon = await ensureManagedDaemon(settings);
  return {
    httpPort: daemon.info.httpPort,
    token: daemon.info.token,
    stateDir: settings.paths.baseDir,
  };
}
