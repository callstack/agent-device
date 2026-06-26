import crypto from 'node:crypto';
import type { RemoteConfigProfile } from '../remote-config-schema.ts';
import { profileToCliFlags } from '../utils/remote-config.ts';
import { AppError } from '../utils/errors.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';
import {
  resolveGeneratedRemoteConfigProfile,
  writeGeneratedRemoteConfig,
} from './generated-remote-config.ts';
import { resolveRequestedLeaseBackend } from './commands/connection-runtime.ts';

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
  const clientId = buildProxyClientId(options.stateDir, daemonBaseUrl);
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
    metroProjectRoot: options.flags.metroProjectRoot,
    metroKind: options.flags.metroKind,
    metroPublicBaseUrl: options.flags.metroPublicBaseUrl,
    metroProxyBaseUrl: options.flags.metroProxyBaseUrl,
    metroBearerToken: options.flags.metroBearerToken,
    metroPreparePort: options.flags.metroPreparePort,
    metroListenHost: options.flags.metroListenHost,
    metroStatusHost: options.flags.metroStatusHost,
    metroStartupTimeoutMs: options.flags.metroStartupTimeoutMs,
    metroProbeTimeoutMs: options.flags.metroProbeTimeoutMs,
    metroRuntimeFile: options.flags.metroRuntimeFile,
    metroNoReuseExisting: options.flags.metroNoReuseExisting,
    metroNoInstallDeps: options.flags.metroNoInstallDeps,
  };
  const remoteConfigPath = writeGeneratedRemoteConfig({
    stateDir: options.stateDir,
    provider: 'proxy',
    profile,
  });
  const remoteConfig = resolveGeneratedRemoteConfigProfile({
    configPath: remoteConfigPath,
    cwd: options.cwd,
    env: options.env,
    provider: 'Proxy',
  });
  return {
    flags: {
      ...profileToCliFlags(remoteConfig.profile),
      ...options.flags,
      remoteConfig: remoteConfig.resolvedPath,
      daemonBaseUrl,
      daemonTransport: options.flags.daemonTransport ?? 'http',
    },
    remoteConfigPath: remoteConfig.resolvedPath,
  };
}

function buildProxyClientId(stateDir: string, daemonBaseUrl: string): string {
  return crypto
    .createHash('sha256')
    .update(`${stateDir}\0${daemonBaseUrl}`)
    .digest('hex')
    .slice(0, 16);
}
