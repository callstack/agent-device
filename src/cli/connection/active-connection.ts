import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { resolveRemoteAuthForCli } from '../auth-session.ts';
import { parseCloudEndpoint } from '../cloud-origin.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  type ConnectionLocation,
  CLOUD_CONNECTION_REASONS,
  cleanExpiredCloudAttachments,
  cloudConnectionUnavailable,
  readCloudConnection,
  withCloudConnectionOwner,
} from './cloud-connection-record.ts';
import {
  type CloudSessionBinding,
  readRemoteConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';

export async function resolveCloudAdmission(options: {
  command: string;
  usesSessions: boolean;
  stateDir: string;
  session: string | undefined;
  binding: CloudSessionBinding | undefined;
  remoteConfig?: string;
  remoteRoute?: boolean;
}) {
  const { command, usesSessions, stateDir, session, binding } = options;
  if (!usesSessions || command === 'auth') return;
  await cleanExpiredCloudAttachments(stateDir);
  if (command === 'connect' || command === 'connection' || command === 'disconnect') return;
  if (!binding && isLegacyCloudProfile(stateDir, options.remoteConfig)) {
    throw new AppError(
      'COMMAND_FAILED',
      'Reconnect this session with connect cloud --force before using it.',
    );
  }
  const location = { stateDir, session: session ?? 'default' };
  if (!binding) {
    if (readCloudConnection(location)) {
      throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.ownsSession.reason);
    }
    if (!options.remoteRoute && !options.remoteConfig) return;
  }
  if (binding) await withCloudConnectionOwner(location, binding.generation, () => {});
  return <T>(start: () => Promise<T>, _phase?: 'startup' | 'dispatch') =>
    withCloudConnectionOwner(location, binding?.generation, start);
}

export function isLegacyCloudProfile(stateDir: string, remoteConfig: string | undefined): boolean {
  return Boolean(
    remoteConfig &&
    path.dirname(remoteConfig) === path.join(stateDir, 'remote-connections', 'generated') &&
    /^cloud-[a-f0-9]+\.json$/.test(path.basename(remoteConfig)),
  );
}

export function requireLegacyTeardownCredential(
  state: RemoteConnectionState,
  flags: Pick<CliFlags, 'daemonAuthToken' | 'daemonBaseUrl'>,
): string {
  const { daemonAuthToken, daemonBaseUrl } = flags;
  const baseUrl = daemonBaseUrl && parseCloudEndpoint(daemonBaseUrl, 'https:', 'http:');
  const saved =
    state.daemon?.baseUrl && parseCloudEndpoint(state.daemon.baseUrl, 'https:', 'http:');
  if (daemonAuthToken?.trim() && baseUrl && baseUrl.href === (saved || undefined)?.href) {
    return daemonAuthToken;
  }
  throw new AppError(
    'UNAUTHORIZED',
    'Disconnecting a legacy cloud connection requires a credential for its saved daemon endpoint.',
    {
      hint: 'Set AGENT_DEVICE_DAEMON_BASE_URL for the saved daemon and provide its token with --daemon-auth-token or AGENT_DEVICE_DAEMON_AUTH_TOKEN.',
    },
  );
}

function hasNamedCloudConnection(location: ConnectionLocation): boolean {
  const state = readRemoteConnectionState(location);
  return Boolean(
    readCloudConnection(location) ||
    state?.cloudSession ||
    isLegacyCloudProfile(location.stateDir, state?.remoteConfigPath),
  );
}

export async function resolveConnectionAuthFlags(options: {
  command: string;
  positionals: string[];
  flags: CliFlags;
  host: HostEnvironment;
  location: ConnectionLocation;
}): Promise<CliFlags> {
  const { command, positionals, flags, host, location } = options;
  if (await usesCloudSessionAuth(command, positionals, flags, host, location)) return flags;
  const resolution = await resolveRemoteAuthForCli({
    command,
    flags,
    stateDir: location.stateDir,
    env: host.env,
  });
  return resolution.flags;
}

async function usesCloudSessionAuth(
  command: string,
  positionals: string[],
  flags: CliFlags,
  host: HostEnvironment,
  location: ConnectionLocation,
): Promise<boolean> {
  if (command === 'disconnect') return hasNamedCloudConnection(location);
  if (command !== 'connect') return false;
  const { selectCloudSessionPath } = await import('./connect-provider-adapters.ts');
  try {
    return selectCloudSessionPath(positionals[0], flags);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'INVALID_ARGS') throw error;
    const { readConnectProvider } = await import('./provider-policy.ts');
    await readConnectProvider(positionals, host.env);
    throw error;
  }
}
