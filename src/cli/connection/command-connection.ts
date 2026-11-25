import {
  admitDaemonStateRoot,
  resolveDaemonPaths,
} from '@agent-device/daemon-contracts/daemon-resolution';
import type { CliFlags } from '@agent-device/contracts/command';
import type { FlagKey } from '@agent-device/command-registry/flag-types';
import { registerDiagnosticSensitiveValue } from '@agent-device/host-kit/diagnostics';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { resolveRemoteConfigProfile } from '@agent-device/remote/remote-config';
import type { RemoteConfigProfile } from '@agent-device/remote/remote-config-schema';
import {
  buildRemoteConnectionDefaults,
  claimRemoteConnectionDefaults,
  readRemoteConnectionDefault,
  readRemoteConnectionState,
  requireLeasedConnectionSession,
  resolveRemoteConnectionDefaults,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { profileToCliFlags } from '../remote-config-flags.ts';
import { isLegacyCloudProfile, requireLegacyTeardownCredential } from './active-connection.ts';

export type CommandConnection = {
  stateDir: string;
  storedState: RemoteConnectionState | null;
  remoteConfigPath: string;
  profile: RemoteConfigProfile;
};

type CommandConnectionOptions = {
  host: HostEnvironment;
  flags: CliFlags;
  explicitFlagKeys: Set<FlagKey>;
  readDefaults: boolean;
  materializes: boolean;
  claimForDisconnect?: boolean;
};

type CommandConnectionContext = {
  daemonPaths: ReturnType<typeof resolveDaemonPaths>;
  effectiveFlags: CliFlags;
  defaults: ReturnType<typeof buildRemoteConnectionDefaults> | null;
  connection: CommandConnection | null;
};

export function resolveCommandConnection(
  options: CommandConnectionOptions,
): CommandConnectionContext {
  const { host, flags, explicitFlagKeys } = options;
  const paths = resolveDaemonPaths(flags.stateDir, host);
  admitDaemonStateRoot({ paths, mode: 'repair' });
  const request = { ...host, session: flags.session, remoteConfig: flags.remoteConfig };
  if (options.claimForDisconnect) {
    const defaults = claimRemoteConnectionDefaults({ ...request, stateDir: paths.baseDir });
    const merged = mergeConnectionFlags(flags, defaults.flags, explicitFlagKeys);
    const effectiveFlags = legacyDisconnectFlags(defaults.claimed, paths.baseDir, merged, host.env);
    return {
      daemonPaths: paths,
      effectiveFlags,
      defaults,
      connection: null,
    };
  }
  const storedState = options.readDefaults
    ? readRemoteConnectionDefault({ stateDir: paths.baseDir, session: flags.session })
    : null;
  const defaults = resolveRemoteConnectionDefaults({
    ...request,
    state: storedState,
  });
  const merged = defaults ? mergeConnectionFlags(flags, defaults.flags, explicitFlagKeys) : flags;
  if (!options.materializes || !merged.remoteConfig) {
    return { daemonPaths: paths, effectiveFlags: merged, defaults, connection: null };
  }
  return resolveMaterializingConnection(options, {
    paths,
    storedState,
    defaults,
    merged,
    remoteConfig: merged.remoteConfig,
  });
}

function legacyDisconnectFlags(
  state: RemoteConnectionState | null | undefined,
  stateDir: string,
  flags: CliFlags,
  env: HostEnvironment['env'],
): CliFlags {
  if (!state || state.cloudSession || !isLegacyCloudProfile(stateDir, state.remoteConfigPath))
    return flags;
  const credential = {
    daemonBaseUrl: env.AGENT_DEVICE_DAEMON_BASE_URL,
    daemonAuthToken: env.AGENT_DEVICE_DAEMON_AUTH_TOKEN,
  };
  requireLegacyTeardownCredential(state, credential);
  return { ...flags, ...credential };
}

function resolveMaterializingConnection(
  options: CommandConnectionOptions,
  discovery: {
    paths: ReturnType<typeof resolveDaemonPaths>;
    storedState: RemoteConnectionState | null;
    defaults: ReturnType<typeof resolveRemoteConnectionDefaults>;
    merged: CliFlags;
    remoteConfig: string;
  },
): CommandConnectionContext {
  const { host, flags, explicitFlagKeys } = options;
  const { paths, storedState, defaults, merged, remoteConfig } = discovery;
  const { resolvedPath, profile } = defaults
    ? { resolvedPath: defaults.state.remoteConfigPath, profile: defaults.profile }
    : resolveRemoteConfigProfile({ ...host, configPath: remoteConfig });
  const daemonPaths =
    merged.stateDir === flags.stateDir ? paths : resolveDaemonPaths(merged.stateDir, host);
  const stateDir = daemonPaths.baseDir;
  const redirected = stateDir !== paths.baseDir;
  if (redirected && merged.daemonAuthToken) {
    registerDiagnosticSensitiveValue(merged.daemonAuthToken);
  }
  const selected = selectCommandRecord({
    daemonPaths,
    redirected,
    storedState,
    session: merged.session ?? 'default',
    requestedSession: flags.session,
  });
  // The discovery record can point at a profile that redirects the state directory. Once that
  // happens, only the record from the effective directory supplies connection defaults.
  const selectedDefaults = redirected
    ? selected && buildRemoteConnectionDefaults(selected, profile)
    : defaults;
  const profileFlags = profileToCliFlags(profile);
  const selectedFlags = redirected
    ? mergeConnectionFlags(flags, selectedDefaults?.flags ?? profileFlags, explicitFlagKeys)
    : merged;
  const effectiveFlags = {
    ...profileFlags,
    ...selectedFlags,
    stateDir,
    remoteConfig: resolvedPath,
    session: merged.session,
  };
  if (redirected && selected?.daemon && selected.daemon.baseUrl === undefined) {
    effectiveFlags.daemonBaseUrl = flags.daemonBaseUrl;
  }

  return {
    daemonPaths,
    effectiveFlags,
    defaults: selectedDefaults,
    connection: { stateDir, storedState: selected, remoteConfigPath: resolvedPath, profile },
  };
}

function selectCommandRecord(options: {
  daemonPaths: ReturnType<typeof resolveDaemonPaths>;
  redirected: boolean;
  storedState: RemoteConnectionState | null;
  session: string;
  requestedSession: string | undefined;
}): RemoteConnectionState | null {
  const { daemonPaths, redirected, storedState, session, requestedSession } = options;
  if (!redirected) return storedState?.session === session ? storedState : null;
  admitDaemonStateRoot({ paths: daemonPaths, mode: 'repair' });
  const selected = readRemoteConnectionState({ stateDir: daemonPaths.baseDir, session });
  if (selected) requireLeasedConnectionSession(selected, requestedSession);
  return selected;
}

function mergeConnectionFlags(
  flags: CliFlags,
  defaults: Partial<CliFlags>,
  explicitFlagKeys: Set<FlagKey>,
): CliFlags {
  const merged = { ...flags };
  for (const [key, value] of Object.entries(defaults) as Array<[FlagKey, unknown]>) {
    if (value === undefined) continue;
    if (explicitFlagKeys.has(key)) continue;
    (merged as Record<string, unknown>)[key] = value;
  }
  return merged;
}
