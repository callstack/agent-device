import crypto from 'node:crypto';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';
import type { EnvMap } from '../../utils/env-map.ts';
import { readMetroProfileFields } from './profile-fields.ts';
import { persistAndResolveGeneratedProfile } from './generated-config.ts';
import { resolveRequestedLeaseBackend } from '../commands/connection-runtime.ts';

export function resolveProxyConnectProfile(options: {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const daemonBaseUrl = options.flags.daemonBaseUrl ?? options.env?.AGENT_DEVICE_DAEMON_BASE_URL;
  if (!daemonBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'connect proxy requires --daemon-base-url <url> or AGENT_DEVICE_DAEMON_BASE_URL.',
    );
  }
  const clientId = buildProxyClientId(options.stateDir, daemonBaseUrl, options.flags.session);
  const profile: RemoteConfigProfile = {
    daemonBaseUrl,
    daemonTransport: options.flags.daemonTransport ?? 'http',
    daemonServerMode: options.flags.daemonServerMode,
    tenant: options.flags.tenant ?? 'proxy',
    sessionIsolation: options.flags.sessionIsolation ?? 'tenant',
    runId: options.flags.runId ?? `proxy-${clientId}`,
    leaseProvider: 'proxy',
    clientId,
    leaseBackend: options.flags.leaseBackend ?? resolveRequestedLeaseBackend(options.flags),
    platform: options.flags.platform,
    target: options.flags.target,
    device: options.flags.device,
    udid: options.flags.udid,
    serial: options.flags.serial,
    iosSimulatorDeviceSet: options.flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: options.flags.androidDeviceAllowlist,
    session: options.flags.session,
    // Secrets must never be persisted in the generated (non-secret) profile.
    // Mirror the cloud path, which keeps daemonAuthToken in-memory only: the
    // bearer token survives this connect via the returned flags below, and
    // later commands re-supply it through AGENT_DEVICE_METRO_BEARER_TOKEN.
    ...readMetroProfileFields(options.flags),
  };
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: 'proxy',
    profile,
    cwd: options.cwd,
    env: options.env,
    flags: options.flags,
    extraFlags: {
      daemonBaseUrl,
      daemonTransport: options.flags.daemonTransport ?? 'http',
    },
  });
}

function buildProxyClientId(
  stateDir: string,
  daemonBaseUrl: string,
  session: string | undefined,
): string {
  return crypto
    .createHash('sha256')
    .update(`${stateDir}\0${daemonBaseUrl}\0${session ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}
