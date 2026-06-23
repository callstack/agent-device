import { randomBytes } from 'node:crypto';
import { createDaemonProxyServer } from '../../daemon-proxy.ts';
import { buildDaemonHttpBaseUrl } from '../../daemon/http-contract.ts';
import { ensureDaemon, resolveClientSettings } from '../../daemon-client-lifecycle.ts';
import { AppError } from '../../utils/errors.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

type ProxyStartup = {
  proxyBaseUrl: string;
  agentDeviceBaseUrl: string;
  token: string;
  upstreamBaseUrl: string;
  stateDir: string;
};

export const proxyCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals.length > 0) {
    throw new AppError('INVALID_ARGS', 'proxy does not accept positional arguments.');
  }
  const startup = await startProxy(flags);
  writeCommandOutput(flags, startup, () => renderProxyStartup(startup));
  await waitForever();
  return true;
};

async function startProxy(flags: CliFlags): Promise<ProxyStartup> {
  const settings = resolveClientSettings({
    session: 'default',
    command: 'proxy',
    positionals: [],
    flags: {
      stateDir: flags.stateDir,
      daemonBaseUrl: '',
      daemonTransport: 'http',
      daemonServerMode: 'http',
    },
  });
  const daemon = await ensureDaemon(settings);
  const upstreamBaseUrl = resolveLocalDaemonBaseUrl(daemon.info.httpPort);
  const token = resolveProxyClientToken(flags);
  const server = createDaemonProxyServer({
    upstreamBaseUrl,
    upstreamToken: daemon.info.token,
    clientToken: token,
  });
  const host = flags.proxyHost?.trim() || '127.0.0.1';
  const port = flags.proxyPort ?? 0;
  await listen(server, host, port);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new AppError('COMMAND_FAILED', 'Proxy did not bind to a TCP address.');
  }
  const proxyBaseUrl = `http://${formatHostForUrl(address.address)}:${address.port}`;
  return {
    proxyBaseUrl,
    agentDeviceBaseUrl: buildDaemonHttpBaseUrl(proxyBaseUrl),
    token,
    upstreamBaseUrl,
    stateDir: settings.paths.baseDir,
  };
}

function resolveLocalDaemonBaseUrl(httpPort: number | undefined): string {
  if (!httpPort) {
    throw new AppError('COMMAND_FAILED', 'Local daemon HTTP endpoint is unavailable.', {
      hint: 'Retry after cleaning daemon state, or run proxy with a fresh --state-dir.',
    });
  }
  return `http://127.0.0.1:${httpPort}`;
}

function resolveProxyClientToken(flags: CliFlags): string {
  return flags.daemonAuthToken?.trim() || randomBytes(32).toString('hex');
}

function listen(server: ReturnType<typeof createDaemonProxyServer>, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function renderProxyStartup(startup: ProxyStartup): string {
  return [
    `agent-device proxy listening on ${startup.proxyBaseUrl}`,
    `daemon base URL: ${startup.agentDeviceBaseUrl}`,
    `daemon auth token: ${startup.token}`,
    'treat the daemon auth token as a secret; anyone with it can control the proxied daemon',
    `upstream local daemon: ${startup.upstreamBaseUrl}`,
    `state dir: ${startup.stateDir}`,
    '',
    'Remote client example:',
    `agent-device devices --daemon-base-url ${startup.agentDeviceBaseUrl} --daemon-auth-token ${startup.token}`,
  ].join('\n');
}

function waitForever(): Promise<never> {
  return new Promise(() => {});
}
