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
import { AppError } from '../../kernel/errors.ts';
import { resolveCloudConnectProfile } from '../cloud-connection-profile.ts';
import { resolveProxyConnectProfile } from '../proxy-connection-profile.ts';
import {
  hasDeferredMetroConfig,
  releaseRemoteConnectionLease,
  releasePreviousLease,
  resolveRequestedLeaseBackend,
  stopMetroCleanup,
  stopReactDevtoolsCleanup,
} from './connection-runtime.ts';
import { writeCommandOutput } from './shared.ts';
import type { LeaseBackend } from '../../kernel/contracts.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import type { ClientCommandHandler } from './router-types.ts';

export const connectCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  const provider = readConnectProvider(positionals);
  assertConnectProviderUsage(provider, flags);
  const resolved = await resolveConnectProfile({ provider, flags, stateDir });
  const connectFlags = resolved.flags;
  const connectionMetadata = readRemoteConfigConnectionMetadata(resolved.remoteConfigPath);
  const scope = readRequiredConnectScope(connectFlags);
  const context = resolveConnectContext({
    stateDir,
    flags: connectFlags,
    remoteConfigPath: resolved.remoteConfigPath,
  });
  assertCompatibleConnectionOrForce(context.previous, {
    flags: connectFlags,
    session: context.session,
    remoteConfigPath: resolved.remoteConfigPath,
    remoteConfigHash: context.remoteConfigHash,
    desiredLeaseBackend: resolveRequestedLeaseBackend(connectFlags),
    connection: connectionMetadata,
    daemon: context.daemon,
  });
  const state = buildConnectedState({
    flags: connectFlags,
    scope,
    connectionMetadata,
    context,
    remoteConfigPath: resolved.remoteConfigPath,
  });
  writeRemoteConnectionState({ stateDir, state });
  await cleanupForcedPreviousConnection(client, stateDir, connectFlags, context.previous);
  const leasePreparation = buildLeasePreparationNotice(state);
  const runtimePreparation = buildRuntimePreparationNotice(connectFlags, state);

  writeCommandOutput(connectFlags, serializeConnectionState(state, runtimePreparation), () =>
    [
      `Connected remote session "${context.session}" tenant "${scope.tenant}" run "${scope.runId}" ${
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

async function resolveConnectProfile(options: {
  provider?: 'proxy';
  flags: CliFlags;
  stateDir: string;
}): Promise<{ flags: CliFlags; remoteConfigPath: string }> {
  const { provider, flags, stateDir } = options;
  if (flags.remoteConfig) return resolveRemoteConnectFlags(flags);
  if (provider === 'proxy' || shouldUseProxyConnectShortcut(flags)) {
    return resolveProxyConnectProfile({
      flags,
      stateDir,
      cwd: process.cwd(),
      env: process.env,
    });
  }
  return await resolveCloudConnectProfile({
    flags,
    stateDir,
    cwd: process.cwd(),
    env: process.env,
  });
}

function assertConnectProviderUsage(provider: 'proxy' | undefined, flags: CliFlags): void {
  if (!provider || !flags.remoteConfig) return;
  throw new AppError(
    'INVALID_ARGS',
    'connect provider positional and --remote-config are mutually exclusive.',
  );
}

function readRequiredConnectScope(flags: CliFlags): { tenant: string; runId: string } {
  if (!flags.tenant) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires tenant in remote config or via --tenant <id>.',
    );
  }
  if (!flags.runId) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires runId in remote config or via --run-id <id>.',
    );
  }
  if (!flags.daemonBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires daemonBaseUrl in remote config, config, env, or --daemon-base-url.',
    );
  }
  return { tenant: flags.tenant, runId: flags.runId };
}

type ConnectContext = {
  session: string;
  remoteConfigHash: string;
  daemon: RemoteConnectionState['daemon'];
  previous: RemoteConnectionState | null;
};

function resolveConnectContext(options: {
  stateDir: string;
  flags: CliFlags;
  remoteConfigPath: string;
}): ConnectContext {
  const { stateDir, flags, remoteConfigPath } = options;
  const activeState = flags.session ? null : readActiveConnectionState({ stateDir });
  const session = flags.session ?? activeState?.session ?? createRemoteSessionName(stateDir);
  const previous =
    activeState?.session === session
      ? activeState
      : readRemoteConnectionState({ stateDir, session });
  return {
    session,
    previous,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon: buildDaemonState(flags),
  };
}

function assertCompatibleConnectionOrForce(
  previous: RemoteConnectionState | null,
  options: Parameters<typeof isCompatibleConnection>[1],
): void {
  if (!previous || isCompatibleConnection(previous, options)) return;
  if (options.flags.force) return;
  throw new AppError(
    'INVALID_ARGS',
    'A different remote connection is already active for this session. Re-run connect with --force to replace it.',
    { session: options.session, remoteConfig: previous.remoteConfigPath },
  );
}

function buildConnectedState(options: {
  flags: CliFlags;
  scope: { tenant: string; runId: string };
  connectionMetadata?: RemoteConnectionRequestMetadata;
  context: ConnectContext;
  remoteConfigPath: string;
}): RemoteConnectionState {
  const { flags, scope, connectionMetadata, context, remoteConfigPath } = options;
  const previous = shouldReusePreviousConnectionState(flags, context.previous)
    ? context.previous
    : null;
  const now = new Date().toISOString();
  const leaseBinding = buildConnectionLeaseBinding(flags, previous, connectionMetadata);
  const runtimeBinding = buildConnectionRuntimeBinding(flags, previous, now);
  return {
    version: 1,
    session: context.session,
    remoteConfigPath,
    remoteConfigHash: context.remoteConfigHash,
    daemon: context.daemon,
    tenant: scope.tenant,
    runId: scope.runId,
    ...leaseBinding,
    ...runtimeBinding,
    updatedAt: now,
  };
}

function buildConnectionLeaseBinding(
  flags: CliFlags,
  previous: RemoteConnectionState | null,
  connectionMetadata: RemoteConnectionRequestMetadata | undefined,
): Pick<
  RemoteConnectionState,
  'clientId' | 'deviceKey' | 'leaseBackend' | 'leaseId' | 'leaseProvider'
> {
  return {
    leaseId: previous?.leaseId,
    leaseBackend: previous?.leaseBackend ?? resolveRequestedLeaseBackend(flags),
    leaseProvider: connectionMetadata?.leaseProvider ?? previous?.leaseProvider,
    clientId: connectionMetadata?.clientId ?? previous?.clientId,
    deviceKey: previous?.deviceKey ?? connectionMetadata?.deviceKey,
  };
}

function buildConnectionRuntimeBinding(
  flags: CliFlags,
  previous: RemoteConnectionState | null,
  now: string,
): Pick<RemoteConnectionState, 'connectedAt' | 'metro' | 'platform' | 'runtime' | 'target'> {
  return {
    platform: flags.platform ?? previous?.platform,
    target: flags.target ?? previous?.target,
    runtime: previous?.runtime,
    metro: previous?.metro,
    connectedAt: previous?.connectedAt ?? now,
  };
}

function shouldReusePreviousConnectionState(
  flags: CliFlags,
  previous: RemoteConnectionState | null,
): previous is RemoteConnectionState {
  return Boolean(previous && !flags.force);
}

async function cleanupForcedPreviousConnection(
  client: Parameters<ClientCommandHandler>[0]['client'],
  stateDir: string,
  flags: CliFlags,
  previous: RemoteConnectionState | null,
): Promise<void> {
  if (!previous || !flags.force) return;
  await stopMetroCleanup(previous.metro);
  await stopReactDevtoolsCleanup({ stateDir, state: previous });
  await releasePreviousLease(client, previous);
}

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
      released = await releaseRemoteConnectionLease(client, state);
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

function shouldUseProxyConnectShortcut(flags: CliFlags): boolean {
  if (!flags.daemonBaseUrl || flags.tenant || flags.runId || flags.leaseId || flags.leaseBackend) {
    return false;
  }
  return isAgentDeviceProxyBaseUrl(flags.daemonBaseUrl);
}

function isAgentDeviceProxyBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.replace(/\/+$/, '').endsWith('/agent-device');
  } catch {
    return false;
  }
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
    requiredConnectionFieldsMatch(state, options) &&
    optionalConnectionFieldsMatch(state, options) &&
    isSameDaemonState(state.daemon, options.daemon)
  );
}

function requiredConnectionFieldsMatch(
  state: RemoteConnectionState,
  options: Parameters<typeof isCompatibleConnection>[1],
): boolean {
  return [
    [state.remoteConfigPath, options.remoteConfigPath],
    [state.remoteConfigHash, options.remoteConfigHash],
    [state.session, options.session],
    [state.tenant, options.flags.tenant],
    [state.runId, options.flags.runId],
  ].every(([left, right]) => left === right);
}

function optionalConnectionFieldsMatch(
  state: RemoteConnectionState,
  options: Parameters<typeof isCompatibleConnection>[1],
): boolean {
  return [
    [state.leaseBackend, options.desiredLeaseBackend],
    [state.platform, options.flags.platform],
    [state.target, options.flags.target],
    [state.leaseProvider, options.connection?.leaseProvider],
    [state.clientId, options.connection?.clientId],
  ].every(([left, right]) => right === undefined || left === right);
}

function isSameDaemonState(
  a: RemoteConnectionState['daemon'],
  b: RemoteConnectionState['daemon'],
): boolean {
  return (['baseUrl', 'transport', 'serverMode'] as const).every(
    (key) => (a?.[key] ?? undefined) === (b?.[key] ?? undefined),
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
  if (state.leaseProvider === 'proxy') {
    return {
      status: 'deferred',
      nextSteps: ['agent-device open <app-id> --relaunch', 'agent-device devices'],
      message:
        'Proxy lease allocation is pending; run open when ready to allocate or refresh the device lease. Devices can inspect inventory but do not allocate a proxy lease.',
    };
  }
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
