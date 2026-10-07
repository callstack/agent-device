import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { buildDaemonHttpBaseUrl } from '@agent-device/contracts/daemon-http';
import type { CliFlags } from '@agent-device/contracts/command';
import { resolveUserPath } from '@agent-device/host-kit/file';
import { AppError } from '@agent-device/kernel/errors';
import { supportsColor } from '../../commands/output/color.ts';
import { createHostServer, type HostTlsMaterial } from '../host/host-server.ts';
import { prepareHostServiceCredential } from '../host/service-credential.ts';
import {
  ensureLocalHttpDaemon,
  formatHostForUrl,
  formatOutputValue,
  listenOnTcp,
  resolveBindAddress,
  resolveLocalHttpDaemonSettings,
  waitForever,
} from '../host/local-daemon.ts';
import { writeCommandOutput } from './shared.ts';
import type { ClientCommandHandler } from './router-types.ts';

type HostStartup = {
  hostBaseUrl: string;
  agentDeviceBaseUrl: string;
  listenAddress: string;
  principal: string;
  credentialFile: string;
  /** Present only on the start that created the credential, so restart logs never repeat it. */
  token?: string;
  upstreamBaseUrl: string;
  stateDir: string;
};

const WILDCARD_ADDRESSES = new Set(['0.0.0.0', '::']);

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
  const bind = resolveBindAddress(flags);
  const tlsMaterial = readHostTlsMaterial(flags);
  if (!tlsMaterial && !isLoopbackHost(bind.host)) {
    throw new AppError('INVALID_ARGS', `host needs TLS to listen on ${bind.host}.`, {
      reason: 'host-tls-required',
      hint: 'Pass --tls-cert and --tls-key, or keep the default 127.0.0.1 bind behind a TLS tunnel.',
    });
  }
  const prepared = prepareHostServiceCredential(path.join(settings.paths.baseDir, 'host'));
  const { upstreamBaseUrl, upstreamToken, stateDir } = await ensureLocalHttpDaemon(
    'host',
    settings,
  );
  const server = createHostServer({
    upstreamBaseUrl,
    upstreamToken,
    credential: prepared.credential,
    tls: tlsMaterial,
  });
  const address = await listenOnTcp(server, bind);
  try {
    prepared.publish();
  } catch (error) {
    server.close();
    throw error;
  }
  const scheme = tlsMaterial ? 'https' : 'http';
  const advertised = formatHostForUrl(advertisedHost(bind.host, address.address));
  const hostBaseUrl = `${scheme}://${advertised}:${address.port}`;
  return {
    hostBaseUrl,
    agentDeviceBaseUrl: buildDaemonHttpBaseUrl(hostBaseUrl),
    listenAddress: `${formatHostForUrl(address.address)}:${address.port}`,
    principal: prepared.credential.principal,
    credentialFile: prepared.credentialFile,
    ...(prepared.created ? { token: prepared.credential.token } : {}),
    upstreamBaseUrl,
    stateDir,
  };
}

function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return bare === 'localhost' || bare === '::1' || /^127\./.test(bare);
}

/**
 * The address workers dial: the name the operator bound to, the machine's name for a wildcard
 * bind (which nobody can dial), or the bound literal address.
 */
function advertisedHost(requestedHost: string, boundAddress: string): string {
  if (WILDCARD_ADDRESSES.has(boundAddress)) return os.hostname();
  return net.isIP(requestedHost.replace(/^\[(.*)\]$/, '$1')) === 0 ? requestedHost : boundAddress;
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
  const material = {
    cert: readTlsFile(certPath, '--tls-cert'),
    key: readTlsFile(keyPath, '--tls-key'),
  };
  try {
    tls.createSecureContext(material);
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      'host cannot use the TLS certificate and key.',
      {
        reason: 'host-tls-invalid',
        hint: 'Pass a PEM certificate with --tls-cert and its matching PEM private key with --tls-key.',
      },
      error,
    );
  }
  return material;
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
  const boundSuffix = startup.hostBaseUrl.endsWith(`//${startup.listenAddress}`)
    ? ''
    : ` (bound to ${startup.listenAddress})`;
  const hostUrl = formatOutputValue(startup.hostBaseUrl, 'cyan', useColor);
  const credentialLines = startup.token
    ? [
        `Service credential created: ${startup.credentialFile}`,
        `Token: ${formatOutputValue(startup.token, 'yellow', useColor)} (shown once; read it from the credential file later)`,
      ]
    : [`Service credential: ${startup.credentialFile}`];
  const workerToken = startup.token ?? '<token from the credential file>';
  return [
    `${formatOutputValue('✓', 'green', useColor)} Host listening at ${hostUrl}${boundSuffix}`,
    '',
    ...credentialLines,
    `Principal: ${startup.principal}`,
    '',
    'Workers connect with:',
    `  agent-device connect proxy --daemon-base-url ${startup.agentDeviceBaseUrl} --daemon-auth-token ${workerToken}`,
  ].join('\n');
}
