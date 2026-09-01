import type {
  CloudArtifact,
  CloudProviderSessionResult,
} from '@agent-device/contracts/observability';
import { resolveDaemonPaths } from '../../daemon/config.ts';
import { resolveRemoteConfigProfile } from '../../remote/remote-config.ts';
import {
  readActiveConnectionState,
  buildRemoteConnectionRequestMetadata,
  mergeRemoteConnectionRequestMetadata,
  readRemoteConnectionState,
  remoteConnectionLeaseIdentityMatches,
  removeRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
  type RemoteConnectionRequestMetadata,
} from '../../remote/remote-connection-state.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  connectProviderNamesForError,
  connectionProviderCapabilities,
  isConnectProviderName,
  type ConnectProvider,
} from '../connection/provider-policy.ts';
import {
  resolveConnectProviderProfile,
  verifyResolvedConnectProvider,
} from '../connection/connect-provider-adapters.ts';
import {
  hasDeferredMetroConfig,
  releaseRemoteConnectionLease,
  releasePreviousLease,
  resolveRequestedLeaseBackend,
  stopMetroCleanup,
  stopReactDevtoolsCleanup,
} from './connection-runtime.ts';
import { writeCommandOutput } from './shared.ts';
import { shellQuoteIfNeeded } from '@agent-device/host-kit/command';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { ClientCommandHandler } from './router-types.ts';
import { resolveConnectContext, type ConnectContext } from './connection-context.ts';
import {
  buildLeasePreparationNotice,
  presentConnectReadiness,
  renderConnectSuccess,
  scopeCommand,
  serializeConnectionState,
  type PreviousLeaseReleaseNotice,
  type RuntimePreparationNotice,
} from './connection-presentation.ts';

export const connectCommand: ClientCommandHandler = async ({ positionals, flags, client }) => {
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  const provider = readConnectProvider(positionals);
  assertConnectProviderUsage(provider, flags);
  const resolved = await resolveConnectProviderProfile({ provider, flags, stateDir });
  const connectFlags = resolved.flags;
  const connectionMetadata = readRemoteConfigConnectionMetadata(resolved.remoteConfigPath);
  const scope = readRequiredConnectScope(connectFlags, connectionMetadata);
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
  const verification = await verifyResolvedConnectProvider(resolved);
  const state = buildConnectedState({
    flags: connectFlags,
    scope,
    connectionMetadata,
    context,
    remoteConfigPath: resolved.remoteConfigPath,
  });
  writeRemoteConnectionState({ stateDir, state });
  const previousLeaseNotice = await cleanupForcedPreviousConnection(
    client,
    stateDir,
    connectFlags,
    context.previous,
    state.daemon?.baseUrl,
  );
  const runtimePreparation = buildRuntimePreparationNotice(connectFlags, state);
  const readiness = presentConnectReadiness(state, verification);

  await writeCommandOutput(
    connectFlags,
    serializeConnectionState({ state, runtimePreparation, readiness, previousLeaseNotice }),
    () => renderConnectSuccess({ state, runtimePreparation, readiness, previousLeaseNotice }),
  );
  return true;
};

function assertConnectProviderUsage(provider: ConnectProvider | undefined, flags: CliFlags): void {
  if (!provider || !flags.remoteConfig) return;
  throw new AppError(
    'INVALID_ARGS',
    'connect provider positional and --remote-config are mutually exclusive.',
  );
}

function readRequiredConnectScope(
  flags: CliFlags,
  connectionMetadata: RemoteConnectionRequestMetadata | undefined,
): { tenant: string; runId: string } {
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
  if (
    !flags.daemonBaseUrl &&
    connectionProviderCapabilities(connectionMetadata?.leaseProvider).requiresRemoteDaemon
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'connect requires daemonBaseUrl in remote config, config, env, or --daemon-base-url.',
    );
  }
  return { tenant: flags.tenant, runId: flags.runId };
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
  const connection = mergeRemoteConnectionRequestMetadata(connectionMetadata ?? {}, previous ?? {});
  return {
    leaseId: previous?.leaseId,
    leaseBackend: previous?.leaseBackend ?? resolveRequestedLeaseBackend(flags),
    ...connection,
    deviceKey: previous?.deviceKey ?? connection.deviceKey,
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
  nextDaemonBaseUrl: string | undefined,
): Promise<PreviousLeaseReleaseNotice | undefined> {
  if (!previous || !flags.force) return undefined;
  await stopMetroCleanup(previous.metro);
  await stopReactDevtoolsCleanup({ stateDir, state: previous });
  return await releasePreviousLease(client, previous, {
    nextDaemonBaseUrl,
    ambientDaemonAuthToken: flags.daemonAuthToken,
    cwd: process.cwd(),
    env: process.env,
  });
}

function readRemoteConfigConnectionMetadata(
  remoteConfigPath: string,
): RemoteConnectionRequestMetadata | undefined {
  const profile = resolveRemoteConfigProfile({
    configPath: remoteConfigPath,
    cwd: process.cwd(),
    env: process.env,
  }).profile;
  return buildRemoteConnectionRequestMetadata(profile);
}

export const disconnectCommand: ClientCommandHandler = async ({ flags, client }) => {
  const { session, stateDir, state } = readRequestedConnectionState(flags);
  if (!state) {
    await writeNoRemoteConnectionOutput(flags, session);
    return true;
  }
  const connectedSession = state.session;

  let providerData: CloudProviderSessionResult | undefined;
  if (state.leaseId || state.runtime || state.metro) {
    try {
      providerData = (
        await client.sessions.close({ session: connectedSession, shutdown: flags.shutdown })
      ).provider;
    } catch {
      // Disconnect is idempotent; the session may already be closed.
    }
  }
  await stopMetroCleanup(state.metro);
  await stopReactDevtoolsCleanup({ stateDir, state });
  let released = false;
  if (state.leaseId) {
    try {
      const release = await releaseRemoteConnectionLease(client, state, flags.daemonAuthToken);
      released = release.released;
      providerData ??= release.provider;
    } catch {
      // Bridges may release on close or be unreachable; local state still needs cleanup.
    }
  }
  removeRemoteConnectionState({ stateDir, session: connectedSession });
  await writeCommandOutput(
    flags,
    {
      connected: false,
      session: connectedSession,
      released,
      ...(providerData ? { provider: providerData } : {}),
    },
    () => renderDisconnectOutput(connectedSession, providerData),
  );
  return true;
};

export const connectionCommand: ClientCommandHandler = async ({ positionals, flags }) => {
  if (positionals[0] !== 'status') {
    throw new AppError('INVALID_ARGS', 'connection accepts only: status');
  }
  const { session, state } = readRequestedConnectionState(flags);
  if (!state) {
    await writeNoRemoteConnectionOutput(flags, session);
    return true;
  }
  const leasePreparation = buildLeasePreparationNotice(state);
  const runtimePreparation = buildRuntimePreparationNoticeFromState(state);
  await writeCommandOutput(flags, serializeConnectionState({ state, runtimePreparation }), () =>
    [
      `Configured remote session "${state.session}".`,
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

function renderDisconnectOutput(
  session: string,
  providerData: CloudProviderSessionResult | undefined,
): string {
  return [
    `Disconnected remote session "${session}".`,
    ...formatProviderReleaseWarnings(providerData),
    ...formatReadyArtifactLinks(providerData?.cloudArtifacts?.cloudArtifacts),
  ].join('\n');
}

function formatProviderReleaseWarnings(
  providerData: CloudProviderSessionResult | undefined,
): string[] {
  const warnings = Array.isArray(providerData?.warnings) ? providerData.warnings : [];
  return warnings.flatMap((warning) => {
    const formatted = formatProviderReleaseWarning(warning);
    return formatted ? [formatted] : [];
  });
}

function formatProviderReleaseWarning(warning: unknown): string | undefined {
  if (!warning || typeof warning !== 'object') return undefined;
  const entry = warning as { code?: unknown; message?: unknown };
  if (typeof entry.message !== 'string' || entry.message.length === 0) return undefined;
  const code = typeof entry.code === 'string' && entry.code.length > 0 ? ` (${entry.code})` : '';
  return `Provider release warning${code}: ${entry.message}`;
}

function formatReadyArtifactLinks(artifacts: CloudArtifact[] | undefined): string[] {
  return (artifacts ?? [])
    .filter((artifact) => (artifact.availability ?? 'ready') === 'ready' && artifact.url)
    .slice(0, 3)
    .map((artifact) => `${artifact.name}: ${artifact.url}`);
}

function readConnectProvider(positionals: string[]): ConnectProvider | undefined {
  const provider = positionals[0];
  if (provider === undefined) return undefined;
  if (positionals.length > 1) {
    throw new AppError('INVALID_ARGS', 'connect accepts at most one provider positional.');
  }
  if (isConnectProviderName(provider)) {
    return provider;
  }
  throw new AppError(
    'INVALID_ARGS',
    `Unknown connect provider: ${provider}. Supported providers: ${connectProviderNamesForError()}.`,
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

async function writeNoRemoteConnectionOutput(flags: CliFlags, session: string): Promise<void> {
  await writeCommandOutput(
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
  const fieldsMatch = [
    [state.leaseBackend, options.desiredLeaseBackend],
    [state.platform, options.flags.platform],
    [state.target, options.flags.target],
  ].every(([left, right]) => right === undefined || left === right);
  return fieldsMatch && remoteConnectionLeaseIdentityMatches(state, options.connection);
}

function isSameDaemonState(
  a: RemoteConnectionState['daemon'],
  b: RemoteConnectionState['daemon'],
): boolean {
  return (['baseUrl', 'transport', 'serverMode'] as const).every(
    (key) => (a?.[key] ?? undefined) === (b?.[key] ?? undefined),
  );
}

function buildRuntimePreparationNotice(
  flags: CliFlags,
  state: RemoteConnectionState,
): RuntimePreparationNotice | undefined {
  if (state.runtime) return undefined;
  if (!hasDeferredMetroConfig(flags) && !remoteConfigHasMetroSettings(state.remoteConfigPath)) {
    return undefined;
  }
  return buildDeferredRuntimeNotice(state);
}

function buildRuntimePreparationNoticeFromState(
  state: RemoteConnectionState,
): RuntimePreparationNotice | undefined {
  if (state.runtime || !remoteConfigHasMetroSettings(state.remoteConfigPath)) return undefined;
  return buildDeferredRuntimeNotice(state);
}

function buildDeferredRuntimeNotice(state: RemoteConnectionState): RuntimePreparationNotice {
  const nextStep = scopeCommand(
    state,
    `agent-device metro prepare --remote-config ${shellQuoteIfNeeded(state.remoteConfigPath)}`,
  );
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
