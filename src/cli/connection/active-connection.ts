import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { resolveRemoteAuthForCli } from '../auth-session.ts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  type ConnectionLocation,
  cleanExpiredCloudAttachments,
  readCloudConnection,
  withCloudConnectionOwner,
} from './cloud-connection-record.ts';
import {
  type CloudSessionBinding,
  readRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';

export async function resolveCloudAdmission(options: {
  command: string;
  usesSessions: boolean;
  stateDir: string;
  session: string | undefined;
  binding: CloudSessionBinding | undefined;
  remoteConfig?: string;
}) {
  const { command, usesSessions, stateDir, session, binding } = options;
  if (!usesSessions || command === 'auth') return;
  await cleanExpiredCloudAttachments(stateDir);
  if (['connect', 'disconnect', 'connection'].includes(command)) return;
  const location = { stateDir, session: session ?? 'default' };
  if (!binding) {
    refuseLegacyCloudProfile(stateDir, options.remoteConfig);
    if (!readCloudConnection(location)) return;
  }
  await withCloudConnectionOwner(location, binding?.generation, () => {});
  return <T>(start: () => Promise<T>, _phase?: 'startup' | 'dispatch') =>
    withCloudConnectionOwner(location, binding?.generation, start);
}

function refuseLegacyCloudProfile(stateDir: string, remoteConfig: string | undefined): void {
  if (!remoteConfig) return;
  const generated = path.join(stateDir, 'remote-connections', 'generated');
  if (
    path.dirname(remoteConfig) !== generated ||
    !/^cloud-[a-f0-9]+\.json$/.test(path.basename(remoteConfig))
  )
    return;
  throw new AppError(
    'COMMAND_FAILED',
    'Reconnect this session with connect cloud --force before using it.',
  );
}

function hasNamedCloudConnection(location: ConnectionLocation): boolean {
  return Boolean(
    readCloudConnection(location) || readRemoteConnectionState(location)?.cloudSession,
  );
}

export async function resolveConnectionAuthFlags(options: {
  command: string;
  provider: string | undefined;
  flags: CliFlags;
  host: HostEnvironment;
  location: ConnectionLocation;
}): Promise<CliFlags> {
  const { command, provider, flags, host, location } = options;
  if (await usesCloudSessionAuth(command, provider, flags, location)) return flags;
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
  provider: string | undefined,
  flags: CliFlags,
  location: ConnectionLocation,
): Promise<boolean> {
  if (command === 'disconnect') return hasNamedCloudConnection(location);
  if (command !== 'connect') return false;
  if (provider === 'cloud') return true;
  if (provider !== undefined || flags.platform === undefined) return false;
  const { usesCloudSessionApi } = await import('./connect-provider-adapters.ts');
  return usesCloudSessionApi(undefined, flags);
}
