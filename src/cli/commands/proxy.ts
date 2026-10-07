import { randomBytes } from 'node:crypto';
import { createDaemonProxyServer } from '@agent-device/proxy';
import { buildDaemonHttpBaseUrl } from '@agent-device/contracts/daemon-http';
import { AppError } from '@agent-device/kernel/errors';
import { colorize, supportsColor } from '../../commands/output/color.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import { writeCommandOutput } from './shared.ts';
import {
  ensureLocalHttpDaemon,
  formatHostForUrl,
  listenOnTcp,
  resolveLocalHttpDaemonSettings,
  waitForever,
} from './local-daemon-front-end.ts';
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
  await writeCommandOutput(flags, startup, () => renderProxyStartup(startup));
  await waitForever();
  return true;
};

async function startProxy(flags: CliFlags): Promise<ProxyStartup> {
  const { upstreamBaseUrl, upstreamToken, stateDir } = await ensureLocalHttpDaemon(
    'proxy',
    resolveLocalHttpDaemonSettings({ command: 'proxy', stateDir: flags.stateDir }),
  );
  const token = resolveProxyClientToken(flags);
  const server = createDaemonProxyServer({
    upstreamBaseUrl,
    upstreamToken,
    clientToken: token,
  });
  const host = flags.proxyHost?.trim() || '127.0.0.1';
  const port = flags.proxyPort ?? 0;
  const address = await listenOnTcp(server, host, port);
  const proxyBaseUrl = `http://${formatHostForUrl(address.address)}:${address.port}`;
  return {
    proxyBaseUrl,
    agentDeviceBaseUrl: buildDaemonHttpBaseUrl(proxyBaseUrl),
    token,
    upstreamBaseUrl,
    stateDir,
  };
}

function resolveProxyClientToken(flags: CliFlags): string {
  return flags.daemonAuthToken?.trim() || randomBytes(32).toString('hex');
}

export function renderProxyStartup(
  startup: ProxyStartup,
  options: { useColor?: boolean } = {},
): string {
  const useColor = options.useColor ?? supportsColor();
  const checkmark = formatProxyOutputValue('✓', 'green', useColor);
  const proxyBaseUrl = formatProxyOutputValue(startup.proxyBaseUrl, 'cyan', useColor);
  const daemonBaseUrl = formatProxyOutputValue('<tunnel URL>', 'cyan', useColor);
  const token = formatProxyOutputValue(startup.token, 'yellow', useColor);
  return [
    `${checkmark} Proxy listening at ${proxyBaseUrl}`,
    '',
    'Provide this to the agent-device instance connecting:',
    '',
    `Daemon base URL: ${daemonBaseUrl}`,
    `Daemon auth token: ${token}`,
  ].join('\n');
}

function formatProxyOutputValue(
  value: string,
  format: Parameters<typeof colorize>[1],
  useColor: boolean,
): string {
  return useColor ? colorize(value, format, { validateStream: false }) : value;
}
