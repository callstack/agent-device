import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDaemonHttpBaseUrl } from '@agent-device/contracts/daemon-http';
import type { CliFlags } from '@agent-device/contracts/command';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { AppError } from '@agent-device/kernel/errors';
import { colorize, supportsColor } from '../../commands/output/color.ts';
import { createHostServer, type HostTlsMaterial } from '../host/host-server.ts';
import { loadOrCreateHostServiceCredential } from '../host/service-credential.ts';
import {
  ensureLocalHttpDaemon,
  formatHostForUrl,
  listenOnTcp,
  resolveLocalHttpDaemonSettings,
  waitForever,
} from './local-daemon-front-end.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

type HostStartup = {
  hostBaseUrl: string;
  agentDeviceBaseUrl: string;
  listenAddress: string;
  principal: string;
  credentialFile: string;
  credentialCreated: boolean;
  /** Present only when this start created the credential, so restart logs never repeat it. */
  token?: string;
  tls: boolean;
  upstreamBaseUrl: string;
  stateDir: string;
};

export const hostCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals.length > 0) {
    throw new AppError('INVALID_ARGS', 'host does not accept positional arguments.');
  }
  const startup = await startHost(flags);
  await writeCommandOutput(flags, startup, () => renderHostStartup(startup));
  await waitForever();
  return true;
};

async function startHost(flags: CliFlags): Promise<HostStartup> {
  // Every Host-side refusal happens before a daemon is started or reused.
  const settings = resolveLocalHttpDaemonSettings({ command: 'host', stateDir: flags.stateDir });
  const tls = readHostTlsMaterial(flags);
  const { credential, credentialFile, created } = loadOrCreateHostServiceCredential(
    path.join(settings.paths.baseDir, 'host'),
  );
  const { upstreamBaseUrl, upstreamToken, stateDir } = await ensureLocalHttpDaemon(
    'host',
    settings,
  );
  const server = createHostServer({ upstreamBaseUrl, upstreamToken, credential, tls });
  const address = await listenOnTcp(
    server,
    flags.proxyHost?.trim() || '127.0.0.1',
    flags.proxyPort ?? 0,
  );
  const scheme = tls ? 'https' : 'http';
  const hostBaseUrl = `${scheme}://${formatHostForUrl(advertisedHost(address.address))}:${address.port}`;
  return {
    hostBaseUrl,
    agentDeviceBaseUrl: buildDaemonHttpBaseUrl(hostBaseUrl),
    listenAddress: `${formatHostForUrl(address.address)}:${address.port}`,
    principal: credential.principal,
    credentialFile,
    credentialCreated: created,
    ...(created ? { token: credential.token } : {}),
    tls: tls !== undefined,
    upstreamBaseUrl,
    stateDir,
  };
}

/** A wildcard bind is not an address a worker can dial, so Host names the machine instead. */
function advertisedHost(boundAddress: string): string {
  return boundAddress === '0.0.0.0' || boundAddress === '::' ? os.hostname() : boundAddress;
}

function readHostTlsMaterial(flags: CliFlags): HostTlsMaterial | undefined {
  const certPath = flags.hostTlsCert?.trim();
  const keyPath = flags.hostTlsKey?.trim();
  if (!certPath && !keyPath) return undefined;
  if (!certPath || !keyPath) {
    throw new AppError('INVALID_ARGS', 'host needs both --tls-cert and --tls-key to serve HTTPS.', {
      reason: 'host-tls-incomplete',
    });
  }
  return { cert: readTlsFile(certPath, '--tls-cert'), key: readTlsFile(keyPath, '--tls-key') };
}

function readTlsFile(rawPath: string, flag: string): Buffer {
  const resolved = resolveUserPath(rawPath);
  try {
    return fs.readFileSync(resolved);
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `host cannot read the ${flag} file.`,
      {
        reason: 'host-tls-unreadable',
        path: resolved,
        hint: `Check that ${resolved} exists and the Host user can read it.`,
      },
      error,
    );
  }
}

function renderHostStartup(startup: HostStartup): string {
  const useColor = supportsColor();
  const format = (value: string, style: Parameters<typeof colorize>[1]) =>
    useColor ? colorize(value, style, { validateStream: false }) : value;
  const credentialLine = startup.credentialCreated
    ? `Service credential created: ${startup.credentialFile}`
    : `Service credential: ${startup.credentialFile}`;
  const boundSuffix = startup.hostBaseUrl.endsWith(`//${startup.listenAddress}`)
    ? ''
    : ` (bound to ${startup.listenAddress})`;
  const tokenLines = startup.token
    ? [
        `Token: ${format(startup.token, 'yellow')} (shown once; read it from the credential file later)`,
      ]
    : [];
  return [
    `${format('✓', 'green')} Host listening at ${format(startup.hostBaseUrl, 'cyan')}${boundSuffix}`,
    '',
    credentialLine,
    `Principal: ${startup.principal}`,
    ...tokenLines,
    '',
    'Workers connect with:',
    `  agent-device connect proxy --daemon-base-url <Host URL>/agent-device --daemon-auth-token <token>`,
  ].join('\n');
}
