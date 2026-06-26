import crypto from 'node:crypto';
import { resolveDaemonPaths } from '../../daemon/config.ts';
import { resolveRemoteConfigProfile } from '../../remote-config.ts';
import {
  buildRemoteConnectionDaemonState,
  fingerprint,
  hashRemoteConfigFile,
  readActiveConnectionState,
  readRemoteConnectionState,
  removeRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
  type RemoteConnectionRequestMetadata,
} from '../../remote-connection-state.ts';
import { AppError } from '../../utils/errors.ts';
import { resolveCloudConnectProfile } from '../cloud-connection-profile.ts';
import { resolveProxyConnectProfile } from '../proxy-connection-profile.ts';
import {
  hasDeferredMetroConfig,
  releasePreviousLease,
  resolveRequestedLeaseBackend,
  stopMetroCleanup,
  stopReactDevtoolsCleanup,
} from './connection-runtime.ts';
import { writeCommandOutput } from './shared.ts';
import type { LeaseBackend } from '../../contracts.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const connectCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  const provider = readConnectProvider(positionals);
  if (provider && flags.remoteConfig) {
    throw new AppError(
      'INVALID_ARGS',
      'connect provider positional and --remote-config are mutually exclusive.',
    );
  }
  const resolved = flags.remoteConfig
    ? resolveRemoteConnectFlags(flags)
    : provider === 'proxy'
      ? resolveProxyConnectProfile({
          flags,
          stateDir,
          cwd: process.cwd(),
          env: process.env,
        })
      : await resolveCloudConnectProfile({
          flags,
          stateDir,
          cwd: process.cwd(),
          env: process.env,
        });
  const connectFlags = resolved.flags;
  const connectionMetadata = readRemoteConfigConnectionMetadata(resolved.remoteConfigPath);
  const tenant = connectFlags.tenant;
  const runId = connectFlags.runId;
  if (!tenant) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires tenant in remote config or via --tenant <id>.',
    );
  }
  if (!runId) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires runId in remote config or via --run-id <id>.',
    );
  }
  if (!connectFlags.daemonBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires daemonBaseUrl in remote config, config, env, or --daemon-base-url.',
    );
  }

  const activeState = connectFlags.session ? null : readActiveConnectionState({ stateDir });
  const session = connectFlags.session ?? activeState?.session ?? createRemoteSessionName(stateDir);
  const remoteConfigHash = hashRemoteConfigFile(resolved.remoteConfigPath);
  const daemon = buildDaemonState(connectFlags);
  const previous =
    activeState?.session === session
      ? activeState
      : readRemoteConnectionState({ stateDir, session });
  if (
    previous &&
    !isCompatibleConnection(previous, {
      flags: connectFlags,
      session,
      remoteConfigPath: resolved.remoteConfigPath,
      remoteConfigHash,
      desiredLeaseBackend: resolveRequestedLeaseBackend(connectFlags),
      connection: connectionMetadata,
      daemon,
    })
  ) {
    if (!connectFlags.force) {
      throw new AppError(
        'INVALID_ARGS',
        'A different remote connection is already active for this session. Re-run connect with --force to replace it.',
        { session, remoteConfig: previous.remoteConfigPath },
      );
    }
  }

  const now = new Date().toISOString();
  const state: RemoteConnectionState = {
    version: 1,
    session,
    remoteConfigPath: resolved.remoteConfigPath,
    remoteConfigHash,
    daemon,
    tenant,
    runId,
    leaseId: previous && !connectFlags.force ? previous.leaseId : undefined,
    leaseBackend:
      previous && !connectFlags.force
        ? previous.leaseBackend
        : resolveRequestedLeaseBackend(connectFlags),
    leaseProvider:
      connectionMetadata?.leaseProvider ??
      (previous && !connectFlags.force ? previous.leaseProvider : undefined),
    clientId:
      connectionMetadata?.clientId ??
      (previous && !connectFlags.force ? previous.clientId : undefined),
    deviceKey: previous && !connectFlags.force ? previous.deviceKey : connectionMetadata?.deviceKey,
    platform:
      connectFlags.platform ?? (previous && !connectFlags.force ? previous.platform : undefined),
    target: connectFlags.target ?? (previous && !connectFlags.force ? previous.target : undefined),
    runtime: previous && !connectFlags.force ? previous.runtime : undefined,
    metro: previous && !connectFlags.force ? previous.metro : undefined,
    connectedAt: previous && !connectFlags.force ? previous.connectedAt : now,
    updatedAt: now,
  };
  writeRemoteConnectionState({ stateDir, state });
  if (previous && connectFlags.force) {
    await stopMetroCleanup(previous.metro);
    await stopReactDevtoolsCleanup({ stateDir, state: previous });
    await releasePreviousLease(client, previous);
  }
  const leasePreparation = buildLeasePreparationNotice(state);
  const runtimePreparation = buildRuntimePreparationNotice(connectFlags, state);

  writeCommandOutput(connectFlags, serializeConnectionState(state, runtimePreparation), () =>
    [
      `Connected remote session "${session}" tenant "${tenant}" run "${runId}" ${
        state.leaseId ? `lease ${state.leaseId}` : 'lease pending'
      }`,
      leasePreparation?.message,
      runtimePreparation?.message,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
  );
  return true;
};

function resolveRemoteConnectFlags(flags: CliFlags): {
  flags: CliFlags;
  remoteConfigPath: string;
} {
  if (!flags.remoteConfig) {
    throw new AppError('INVALID_ARGS', 'connect requires --remote-config <path>.');
  }
  const remoteConfig = resolveRemoteConfigProfile({
    configPath: flags.remoteConfig,
    cwd: process.cwd(),
    env: process.env,
  });
  return {
    flags,
    remoteConfigPath: remoteConfig.resolvedPath,
  };
}

function readRemoteConfigConnectionMetadata(
  remoteConfigPath: string,
): RemoteConnectionRequestMetadata | undefined {
  const profile = resolveRemoteConfigProfile({
    configPath: remoteConfigPath,
    cwd: process.cwd(),
    env: process.env,
  }).profile;
  const metadata = {
    leaseProvider: profile.leaseProvider,
    clientId: profile.clientId,
    deviceKey: profile.deviceKey,
  };
  return Object.values(metadata).some((value) => value !== undefined) ? metadata : undefined;
}

export const disconnectCommand: ClientCommandHandler = async ({ flags, client }) => {
  const { session, stateDir, state } = readRequestedConnectionState(flags);
  if (!state) {
    writeNoRemoteConnectionOutput(flags, session);
    return true;
  }
  const connectedSession = state.session;

  try {
    await client.sessions.close({ shutdown: flags.shutdown });
  } catch {
    // Disconnect is idempotent; the session may already be closed.
  }
  await stopMetroCleanup(state.metro);
  await stopReactDevtoolsCleanup({ stateDir, state });
  let released = false;
  if (state.leaseId) {
    try {
      const result = await client.leases.release({
        tenant: state.tenant,
        runId: state.runId,
        leaseId: state.leaseId,
        leaseProvider: state.leaseProvider,
        clientId: state.clientId,
        deviceKey: state.deviceKey,
      });
      released = result.released;
    } catch {
      // Bridges may release on close or be unreachable; local state still needs cleanup.
    }
  }
  removeRemoteConnectionState({ stateDir, session: connectedSession });
  writeCommandOutput(
    flags,
    { connected: false, session: connectedSession, released },
    () => `Disconnected remote session "${connectedSession}".`,
  );
  return true;
};

export const connectionCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals[0] !== 'status') {
    throw new AppError('INVALID_ARGS', 'connection accepts only: status');
  }
  const { session, state } = readRequestedConnectionState(flags);
  if (!state) {
    writeNoRemoteConnectionOutput(flags, session);
    return true;
  }
  const leasePreparation = buildLeasePreparationNotice(state);
  const runtimePreparation = buildRuntimePreparationNoticeFromState(state);
  writeCommandOutput(flags, serializeConnectionState(state, runtimePreparation), () =>
    [
      `Connected remote session "${state.session}".`,
      `tenant=${state.tenant} runId=${state.runId} leaseId=${state.leaseId ?? 'pending'} backend=${state.leaseBackend ?? 'pending'}`,
      `remoteConfig=${state.remoteConfigPath}`,
      state.runtime ? 'metro=prepared' : 'metro=not-prepared',
      leasePreparation?.message,
      runtimePreparation?.message,
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n'),
  );
  return true;
};

function createRemoteSessionName(stateDir: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `adc-${crypto.randomBytes(3).toString('hex')}`;
    if (!readRemoteConnectionState({ stateDir, session: candidate })) {
      return candidate;
    }
  }
  return `adc-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}

function readConnectProvider(positionals: string[]): 'proxy' | undefined {
  const provider = positionals[0];
  if (provider === undefined) return undefined;
  if (positionals.length > 1) {
    throw new AppError('INVALID_ARGS', 'connect accepts at most one provider positional.');
  }
  if (provider === 'proxy') return provider;
  throw new AppError(
    'INVALID_ARGS',
    `Unknown connect provider: ${provider}. Supported providers: proxy.`,
  );
}

function readRequestedConnectionState(flags: CliFlags): {
  session: string;
  stateDir: string;
  state: RemoteConnectionState | null;
} {
  const session = flags.session ?? 'default';
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  return {
    session,
    stateDir,
    state:
      readRemoteConnectionState({ stateDir, session }) ??
      (flags.session ? null : readActiveConnectionState({ stateDir })),
  };
}

function writeNoRemoteConnectionOutput(flags: CliFlags, session: string): void {
  writeCommandOutput(
    flags,
    { connected: false, session },
    () => `No remote connection for "${session}".`,
  );
}

function isCompatibleConnection(
  state: RemoteConnectionState,
  options: {
    flags: CliFlags;
    session: string;
    remoteConfigPath: string;
    remoteConfigHash: string;
    desiredLeaseBackend?: LeaseBackend;
    connection?: RemoteConnectionRequestMetadata;
    daemon: RemoteConnectionState['daemon'];
  },
): boolean {
  return (
    state.remoteConfigPath === options.remoteConfigPath &&
    state.remoteConfigHash === options.remoteConfigHash &&
    state.session === options.session &&
    state.tenant === options.flags.tenant &&
    state.runId === options.flags.runId &&
    (options.desiredLeaseBackend === undefined ||
      state.leaseBackend === options.desiredLeaseBackend) &&
    (options.flags.platform === undefined || state.platform === options.flags.platform) &&
    (options.flags.target === undefined || state.target === options.flags.target) &&
    (options.connection?.leaseProvider === undefined ||
      state.leaseProvider === options.connection.leaseProvider) &&
    (options.connection?.clientId === undefined ||
      state.clientId === options.connection.clientId) &&
    isSameDaemonState(state.daemon, options.daemon)
  );
}

function isSameDaemonState(
  a: RemoteConnectionState['daemon'],
  b: RemoteConnectionState['daemon'],
): boolean {
  return (
    (a?.baseUrl ?? undefined) === (b?.baseUrl ?? undefined) &&
    (a?.transport ?? undefined) === (b?.transport ?? undefined) &&
    (a?.serverMode ?? undefined) === (b?.serverMode ?? undefined)
  );
}

function buildDaemonState(flags: CliFlags): RemoteConnectionState['daemon'] {
  return buildRemoteConnectionDaemonState(flags);
}

type RuntimePreparationNotice = {
  status: 'deferred';
  message: string;
  nextStep: string;
};

type LeasePreparationNotice = {
  status: 'deferred';
  message: string;
  nextSteps: string[];
};

function buildRuntimePreparationNotice(
  flags: CliFlags,
  state: RemoteConnectionState,
): RuntimePreparationNotice | undefined {
  if (state.runtime) return undefined;
  if (!hasDeferredMetroConfig(flags) && !remoteConfigHasMetroSettings(state.remoteConfigPath)) {
    return undefined;
  }
  return buildDeferredRuntimeNotice(state.remoteConfigPath);
}

function buildRuntimePreparationNoticeFromState(
  state: RemoteConnectionState,
): RuntimePreparationNotice | undefined {
  if (state.runtime || !remoteConfigHasMetroSettings(state.remoteConfigPath)) return undefined;
  return buildDeferredRuntimeNotice(state.remoteConfigPath);
}

function buildLeasePreparationNotice(
  state: RemoteConnectionState,
): LeasePreparationNotice | undefined {
  if (state.leaseId) return undefined;
  const needsPlatform =
    state.platform === undefined && state.leaseBackend === undefined
      ? ' Add --platform ios|android if the profile does not set a platform.'
      : '';
  const nextSteps = [
    'agent-device install-from-source <artifact-url> --platform ios|android',
    'agent-device open <app-id> --relaunch',
    'agent-device snapshot -i',
    'agent-device devices',
  ];
  return {
    status: 'deferred',
    nextSteps,
    message:
      'Lease allocation is pending; run install-from-source, open, snapshot, or devices when ready to allocate or refresh the lease.' +
      needsPlatform,
  };
}

function buildDeferredRuntimeNotice(remoteConfigPath: string): RuntimePreparationNotice {
  const nextStep = `agent-device metro prepare --remote-config ${remoteConfigPath}`;
  return {
    status: 'deferred',
    nextStep,
    message:
      `Metro runtime is not prepared yet; it will be prepared automatically on first open, ` +
      `or run "${nextStep}" to inspect it before launch.`,
  };
}

function remoteConfigHasMetroSettings(remoteConfigPath: string): boolean {
  try {
    const remoteConfig = resolveRemoteConfigProfile({
      configPath: remoteConfigPath,
      cwd: process.cwd(),
      env: process.env,
    });
    const profile = remoteConfig.profile;
    return Boolean(
      profile.metroPublicBaseUrl ||
      profile.metroProxyBaseUrl ||
      profile.metroProjectRoot ||
      profile.metroKind,
    );
  } catch {
    return false;
  }
}

function serializeConnectionState(
  state: RemoteConnectionState,
  runtimePreparation?: RuntimePreparationNotice,
): Record<string, unknown> {
  const leasePreparation = buildLeasePreparationNotice(state);
  return {
    connected: true,
    session: state.session,
    tenant: state.tenant,
    runId: state.runId,
    leaseAllocated: Boolean(state.leaseId),
    leaseId: state.leaseId,
    leaseBackend: state.leaseBackend,
    platform: state.platform,
    target: state.target,
    remoteConfig: state.remoteConfigPath,
    remoteConfigHash: state.remoteConfigHash,
    daemonBaseUrlFingerprint: fingerprint(state.daemon?.baseUrl),
    metro: state.metro
      ? { prepared: true, projectRoot: state.metro.projectRoot }
      : { prepared: false },
    ...(leasePreparation ? { leasePreparation } : {}),
    ...(runtimePreparation ? { runtimePreparation } : {}),
    connectedAt: state.connectedAt,
    updatedAt: state.updatedAt,
  };
}
