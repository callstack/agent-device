import { resolveHostedCloudAccess } from '../connection/cloud-access.ts';
import {
  readCloudSessionRequest,
  type CreatedCloudSession,
} from '../connection/cloud-session-api.ts';
import { writeCloudAttachment } from '../connection/cloud-attachment.ts';
import { hasHostedLimrunPlugin } from '../connection/cloud-limrun.ts';
import {
  cloudConnectionUnavailable,
  CLOUD_CONNECTION_REASONS,
  readCloudConnection,
  refuseContendedConnection,
  removeCloudConnection,
  withConnectionLock,
} from '../connection/cloud-connection-record.ts';
import {
  connectCloudSession,
  forgetCloudConnection,
  releaseCloudConnection,
  type CloudConnectionRelease,
} from '../connection/cloud-connect.ts';
import { writeStderr } from '../process-exit.ts';
import {
  isLegacyCloudProfile,
  requireLegacyTeardownCredential,
} from '../connection/active-connection.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { CloudProviderSessionResult } from '@agent-device/contracts/observability';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { resolveRemoteConfigProfile } from '@agent-device/remote/remote-config';
import {
  claimRemoteConnectionState,
  readActiveConnectionState,
  requireLeasedConnectionSession,
  sessionLeaseScope,
  buildRemoteConnectionRequestMetadata,
  mergeRemoteConnectionRequestMetadata,
  readRemoteConnectionState,
  remoteConnectionLeaseIdentityMatches,
  removeRemoteConnectionState,
  connectionPlatformMatchesSelection,
  narrowConnectionPlatform,
  writeRemoteConnectionState,
  type RemoteConnectionState,
  type CloudSessionBinding,
  type RemoteConnectionRequestMetadata,
} from '@agent-device/remote/remote-connection-state';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import {
  isInactiveLeaseError,
  remoteSessionRequiredError,
} from '@agent-device/contracts/lease-scope';
import {
  admitProviderForRoute,
  connectionProviderCapabilities,
  readConnectProvider,
  type ConnectProvider,
} from '../connection/provider-policy.ts';
import {
  resolveConnectProviderProfile,
  resolveCloudSessionProfile,
  selectCloudSessionPath,
  type ResolvedConnectProfile,
  verifyResolvedConnectProvider,
} from '../connection/connect-provider-adapters.ts';
import {
  connectionPlatformConflict,
  releaseRemoteConnectionLease,
  resolveRequestedLeaseBackend,
} from './connection-lease-transaction.ts';
import { hasDeferredMetroConfig, stopMetroCleanup } from './connection-metro-runtime.ts';
import { releasePreviousLease } from './connection-previous-lease.ts';
import {
  removeGeneratedRemoteConfigIfUnused,
  requireConnectionTarget,
} from '../connection/generated-config.ts';
import { connectEnvironment } from '../remote-config-flags.ts';
import { writeCommandOutput } from './shared.ts';
import { formatDeliveredArtifactLines } from '@agent-device/command-output';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
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

export const connectCommand: ClientCommandHandler = async (input) => {
  const { positionals, flags } = input;
  const env = connectEnvironment(input.host.env);
  const host = { ...input.host, env };
  const params = { ...input, host };
  const stateDir = resolveDaemonPaths(flags.stateDir, host).baseDir;
  const provider = await readConnectProvider(positionals, host.env);
  assertConnectProviderUsage(provider, flags);
  const cloud = selectCloudSessionPath(provider, flags);

  const location = { stateDir, session: flags.session ?? 'default' };
  return await withConnectionLock(
    stateDir,
    location.session,
    async () => {
      const previous = readRemoteConnectionState(location);
      const record = readCloudConnection(location);
      if (flags.session === undefined && (cloud || record || previous?.cloudSession)) {
        throw remoteSessionRequiredError(undefined);
      }
      const pending = record?.phase === 'pending' ? record : null;
      if (pending && !cloud)
        throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.pendingConflict.reason);
      if (previous && (previous.cloudSession || cloud) && !pending && !flags.force) {
        throw activeConnectionConflict(previous);
      }
      if (record && !pending && !flags.force) {
        throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.pendingConflict.reason);
      }
      const connection = {
        location,
        record,
        state: previous,
        host,
      };
      if (cloud) {
        return await connectCloudProfile(params, connection, pending);
      }
      return await connectDirectProfile(params, stateDir, provider, connection);
    },
    cloud ? () => refuseContendedConnection(location, 'connect') : undefined,
  );
};

type CloudConnection = Omit<Parameters<typeof releaseCloudConnection>[0], 'client'>;

function leaseReleaseWarning(session: string, leaseReleaseError: string): string {
  return `Warning: the proxy front for session "${session}" did not confirm its lease release (${leaseReleaseError}); the lease ends when its heartbeats stop.`;
}

function warnLeaseReleaseFailure(release: CloudConnectionRelease, session: string): void {
  if (release.leaseReleaseError) {
    writeStderr(`${leaseReleaseWarning(session, release.leaseReleaseError)}\n`);
  }
}
type ConnectionCommandParams = Parameters<ClientCommandHandler>[0];

async function connectDirectProfile(
  params: ConnectionCommandParams,
  stateDir: string,
  provider: ConnectProvider | undefined,
  connection: CloudConnection,
): Promise<boolean> {
  const { flags, host } = params;
  const replacingCloud = connection.record || connection.state?.cloudSession;
  const resolved = await resolveConnectProviderProfile({
    flags,
    stateDir,
    cwd: host.cwd,
    env: host.env,
    provider,
  });
  if (!replacingCloud) return await saveConnectProfile(params, stateDir, resolved);
  return await saveConnectProfile(params, stateDir, resolved, {
    beforeCommit: async () => {
      warnLeaseReleaseFailure(
        await releaseCloudConnection({ ...connection, client: params.client }),
        connection.location.session,
      );
    },
    onCommitted: () => removeCloudConnection(connection.location),
  });
}

async function connectCloudProfile(
  params: ConnectionCommandParams,
  connection: CloudConnection,
  pending: CloudConnection['record'],
): Promise<boolean> {
  const { location, record, state, host } = connection;
  requireConnectionTarget(params.flags, 'mobile');
  const accepts = pending
    ? pending.accepts
    : (await hasHostedLimrunPlugin(host.env))
      ? (['agent-device-daemon', 'limrun'] as const)
      : undefined;
  const request = readCloudSessionRequest(params.flags, accepts);
  const access = await resolveHostedCloudAccess({
    env: host.env,
    noLogin: params.flags.noLogin,
    stateDir: location.stateDir,
    interactive: true,
    savedOrigin: pending?.origin,
  });
  if (!pending && (record || state?.cloudSession)) {
    warnLeaseReleaseFailure(
      await releaseCloudConnection({ ...connection, client: params.client }),
      connection.location.session,
    );
  }
  const replacingDirect = pending && state && !state.cloudSession;
  const connectParams = replacingDirect
    ? { ...params, flags: { ...params.flags, force: true } }
    : params;
  return await connectCloudSession({
    location,
    pending,
    request,
    access,
    attach: async (session, commit) => {
      const { stateDir } = location;
      const resolved = await resolveCloudSessionProfile(
        {
          flags: connectParams.flags,
          stateDir,
          cwd: host.cwd,
          env: host.env,
        },
        session,
      );
      try {
        return await saveConnectProfile(connectParams, stateDir, resolved, {
          cloud: session,
          beforeCommit: () => writeCloudAttachment(location, session.attachment),
          onCommitted: commit,
        });
      } finally {
        removeGeneratedRemoteConfigIfUnused({
          stateDir,
          remoteConfigPath: resolved.remoteConfigPath,
        });
      }
    },
  });
}

async function saveConnectProfile(
  { flags, client, host }: Parameters<ClientCommandHandler>[0],
  stateDir: string,
  resolved: ResolvedConnectProfile,
  publication?: {
    cloud?: CreatedCloudSession & { binding: CloudSessionBinding };
    beforeCommit: () => void | Promise<void>;
    onCommitted: () => void;
  },
): Promise<boolean> {
  const cloud = publication?.cloud;
  const { flags: connectFlags, connection: connectionMetadata } = scopeConnectProfile(
    flags,
    resolved,
    host,
  );
  const scope = readRequiredConnectScope(connectFlags, connectionMetadata, host.env, cloud);
  const context = resolveConnectContext({
    stateDir,
    flags: connectFlags,
    remoteConfigPath: resolved.remoteConfigPath,
  });
  assertCompatibleConnectionOrForce(
    cloud && context.previous?.cloudSession ? null : context.previous,
    {
      flags: connectFlags,
      session: context.session,
      remoteConfigPath: resolved.remoteConfigPath,
      remoteConfigHash: context.remoteConfigHash,
      desiredLeaseBackend: resolveRequestedLeaseBackend(connectFlags),
      connection: connectionMetadata,
      daemon: context.daemon,
    },
  );
  const verification = cloud
    ? {
        service: 'the cloud session API',
        status: 'verified' as const,
        verificationMessage: 'Cloud session created.',
      }
    : await verifyResolvedConnectProvider(resolved, host);
  const state = buildConnectedState({
    flags: connectFlags,
    scope,
    connectionMetadata,
    context,
    remoteConfigPath: resolved.remoteConfigPath,
  });
  if (cloud) state.cloudSession = cloud.binding;
  await publication?.beforeCommit();
  writeRemoteConnectionState({
    stateDir,
    state,
    onSessionRecordCommitted: publication?.onCommitted,
  });
  const previousLeaseNotice = await cleanupForcedPreviousConnection(
    client,
    connectFlags,
    context.previous,
    state,
    host,
  );
  const runtimePreparation = buildRuntimePreparationNotice(connectFlags, state, host);
  const readiness = presentConnectReadiness(state, verification, host.env, connectFlags);

  if (flags.showViewer && cloud?.viewerUrl) {
    const { openUrlInBrowser } = await import('../browser-launch.ts');
    await openUrlInBrowser(cloud.viewerUrl);
  }
  await writeCommandOutput(
    connectFlags,
    serializeConnectionState({
      state,
      runtimePreparation,
      readiness,
      previousLeaseNotice,
      env: host.env,
      fallbackFrom: cloud?.fallbackFrom,
    }),
    () =>
      renderConnectSuccess({
        state,
        runtimePreparation,
        readiness,
        previousLeaseNotice,
        env: host.env,
        fallbackFrom: cloud?.fallbackFrom,
      }),
  );
  return true;
}

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
  env: NodeJS.ProcessEnv,
  cloud?: CreatedCloudSession,
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
    !cloud &&
    !flags.daemonBaseUrl &&
    connectionProviderCapabilities(connectionMetadata?.leaseProvider, env).requiresRemoteDaemon
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
  throw activeConnectionConflict(previous);
}

function activeConnectionConflict(previous: RemoteConnectionState): AppError {
  return new AppError(
    'INVALID_ARGS',
    'A different remote connection is already active for this session. Re-run connect with --force to replace it.',
    { session: previous.session, remoteConfig: previous.remoteConfigPath },
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
  const runtimeBinding = buildConnectionRuntimeBinding(
    flags,
    previous,
    now,
    leaseBinding,
    context.session,
  );
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

type ConnectionLeaseBinding = Pick<
  RemoteConnectionState,
  'clientId' | 'deviceKey' | 'leaseBackend' | 'leaseId' | 'leaseProvider'
>;

function buildConnectionLeaseBinding(
  flags: CliFlags,
  previous: RemoteConnectionState | null,
  connectionMetadata: RemoteConnectionRequestMetadata | undefined,
): ConnectionLeaseBinding {
  const connection = mergeRemoteConnectionRequestMetadata(connectionMetadata ?? {}, previous ?? {});
  const leaseBackend = previous?.leaseBackend ?? resolveRequestedLeaseBackend(flags);
  if (leaseBackend === 'macos-app') {
    return buildHostAllocatedLeaseBinding(flags, previous, connection);
  }
  return {
    leaseId: previous?.leaseId,
    leaseBackend,
    ...connection,
    deviceKey: previous?.deviceKey ?? connection.deviceKey,
  };
}

function buildHostAllocatedLeaseBinding(
  flags: CliFlags,
  previous: RemoteConnectionState | null,
  connection: RemoteConnectionRequestMetadata,
): ConnectionLeaseBinding {
  return {
    leaseId: flags.leaseId ?? previous?.leaseId,
    leaseBackend: 'macos-app',
    ...connection,
  };
}

/**
 * Writes what a reused connection is bound to on the platform axis.
 *
 * `--platform apple` on a connection whose backend rents iOS instances is the family being named
 * again, not a request to widen the record back to the family: once a lease is bound the leaf is the
 * truth, and a record that loses it lets the next command ask for any Apple leaf and be served on
 * this one (#2962). The lease binding is asked first because the backend is what decides a family.
 */
function buildConnectionRuntimeBinding(
  flags: CliFlags,
  previous: RemoteConnectionState | null,
  now: string,
  leaseBinding: Pick<RemoteConnectionState, 'leaseBackend'>,
  session: string,
): Pick<RemoteConnectionState, 'connectedAt' | 'metro' | 'platform' | 'runtime' | 'target'> {
  const platform = narrowConnectionPlatform({
    leaseBackend: leaseBinding.leaseBackend,
    recordedPlatform: previous?.platform,
    requestedPlatform: flags.platform,
  });
  if (!platform.ok) {
    throw connectionPlatformConflict({
      session,
      leaseBackend: leaseBinding.leaseBackend,
      boundPlatform: platform.boundPlatform,
      requestedPlatform: platform.requestedPlatform,
      detail: previous ? 'bound-connection' : 'requested-backend',
    });
  }
  return {
    platform: platform.platform,
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
  flags: CliFlags,
  previous: RemoteConnectionState | null,
  next: RemoteConnectionState,
  host: HostEnvironment,
): Promise<PreviousLeaseReleaseNotice | undefined> {
  if (!previous || !flags.force || previous.cloudSession) return undefined;
  await stopMetroCleanup(previous.metro);
  if (previous.leaseId && previous.leaseId === next.leaseId) return undefined;
  return await releasePreviousLease(client, previous, {
    nextDaemonBaseUrl: next.daemon?.baseUrl,
    ambientDaemonAuthToken: flags.daemonAuthToken,
    cwd: host.cwd,
    env: host.env,
  });
}

/**
 * The flags and lease metadata `connect` binds a profile to. A leased profile the caller supplies is
 * shared by every session that names it, so each session connects under a client and run of its own
 * (#3931); a provider-generated profile already derives both from the session.
 */
function scopeConnectProfile(
  flags: CliFlags,
  resolved: { flags: CliFlags; remoteConfigPath: string },
  host: HostEnvironment,
): { flags: CliFlags; connection: RemoteConnectionRequestMetadata | undefined } {
  const profile = resolveRemoteConfigProfile({
    configPath: resolved.remoteConfigPath,
    cwd: host.cwd,
    env: host.env,
  }).profile;
  if (!flags.remoteConfig || flags.session === undefined) {
    return { flags: resolved.flags, connection: buildRemoteConnectionRequestMetadata(profile) };
  }
  const scope = sessionLeaseScope(
    { ...profile, leaseId: resolved.flags.leaseId, runId: profile.runId },
    flags.session,
  );
  return {
    flags:
      resolved.flags.runId === profile.runId
        ? { ...resolved.flags, runId: scope.runId }
        : resolved.flags,
    connection: buildRemoteConnectionRequestMetadata({ ...profile, clientId: scope.clientId }),
  };
}

/**
 * The record moves to its session's own path before any teardown, so a record this command cannot
 * remove is refused before its session closes or its lease ends. The CLI claims it before it builds
 * the client, and that claim is the one torn down.
 */
function claimDisconnectTarget(
  claimedConnection: RemoteConnectionState | null | undefined,
  stateDir: string,
  session: string | undefined,
): RemoteConnectionState | null {
  if (claimedConnection !== undefined) return claimedConnection;
  return claimRemoteConnectionState({ stateDir, session });
}

export const disconnectCommand: ClientCommandHandler = async ({
  flags,
  client,
  host,
  claimedConnection,
}) => {
  if (flags.forget && flags.session === undefined) throw remoteSessionRequiredError(undefined);
  if (flags.forget && flags.shutdown) {
    throw new AppError('INVALID_ARGS', 'Use disconnect --forget separately from --shutdown.');
  }
  const stateDir = resolveConnectionStateDir(flags, host);
  const location = { stateDir, session: flags.session ?? 'default' };
  return await withConnectionLock(
    stateDir,
    location.session,
    async () => {
      if (flags.forget) {
        const state = readRemoteConnectionState(location);
        return await disconnectForget({ client, location, state, host }, flags);
      }
      const record = readCloudConnection(location);
      const current = readRemoteConnectionState(location);
      const state =
        record || current?.cloudSession || claimedConnection?.cloudSession
          ? current
          : claimDisconnectTarget(claimedConnection, stateDir, flags.session);
      if (record || state?.cloudSession) {
        return await disconnectCloud({ location, state, record, host }, flags, client);
      }
      if (!state) {
        await writeNoRemoteConnectionOutput(flags, flags.session ?? 'default');
        return true;
      }
      requireLeasedConnectionSession(state, flags.session);
      if (isLegacyCloudProfile(stateDir, state.remoteConfigPath)) {
        if (
          !current ||
          current.leaseId !== state.leaseId ||
          current.tenant !== state.tenant ||
          current.runId !== state.runId ||
          current.remoteConfigPath !== state.remoteConfigPath ||
          !remoteConnectionLeaseIdentityMatches(current, state)
        ) {
          throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.changed.reason);
        }
        await disconnectLegacyCloud(flags, client, stateDir, current);
        return true;
      }
      return await disconnectProvider(flags, client, stateDir, state);
    },
    flags.forget
      ? undefined
      : () => refuseContendedConnection(location, 'disconnect', claimedConnection),
  );
};

async function disconnectForget(
  connection: Parameters<typeof forgetCloudConnection>[0],
  flags: CliFlags,
): Promise<boolean> {
  const { location } = connection;
  if (!(await forgetCloudConnection(connection))) {
    await writeNoRemoteConnectionOutput(flags, location.session);
    return true;
  }
  writeStderr('Warning: A rental may still exist on the hosted broker until its deadline.\n');
  await writeCommandOutput(
    flags,
    { connected: false, session: location.session, released: false, forgotten: true },
    () => `Cleared local hosted connection "${location.session}".`,
  );
  return true;
}

async function disconnectLegacyCloud(
  flags: CliFlags,
  client: ConnectionCommandParams['client'],
  stateDir: string,
  state: RemoteConnectionState,
): Promise<void> {
  const token = requireLegacyTeardownCredential(state, flags);
  if (state.leaseId) await releaseLegacyCloudLease(client, state, token);
  await stopMetroCleanup(state.metro);
  removeRemoteConnectionState({ stateDir, session: state.session });
  removeGeneratedRemoteConfigIfUnused({ stateDir, remoteConfigPath: state.remoteConfigPath });
  await writeCommandOutput(
    flags,
    { connected: false, session: state.session, released: true },
    () => `Ended cloud session "${state.session}".`,
  );
}

async function releaseLegacyCloudLease(
  client: ConnectionCommandParams['client'],
  state: RemoteConnectionState,
  token: string,
): Promise<void> {
  try {
    const { released, absent } = await releaseRemoteConnectionLease(client, state, token);
    if (!released && !absent) {
      throw new AppError('COMMAND_FAILED', 'The saved daemon did not confirm lease release.');
    }
  } catch (error) {
    if (!isInactiveLeaseError(error)) throw error;
  }
}

async function disconnectCloud(
  connection: CloudConnection,
  flags: CliFlags,
  client: ConnectionCommandParams['client'],
): Promise<boolean> {
  if (flags.session === undefined) throw remoteSessionRequiredError(undefined);
  const { cloudSessionId, leaseReleaseError } = await releaseCloudConnection({
    ...connection,
    client,
  });
  removeCloudConnection(connection.location);
  const { session } = connection.location;
  await writeCommandOutput(
    flags,
    {
      connected: false,
      session,
      cloudSessionId,
      released: true,
      ...(leaseReleaseError ? { leaseReleaseError } : {}),
    },
    () =>
      leaseReleaseError
        ? `Ended cloud session "${session}". ${leaseReleaseWarning(session, leaseReleaseError)}`
        : `Ended cloud session "${session}".`,
  );
  return true;
}

async function disconnectProvider(
  flags: CliFlags,
  client: ConnectionCommandParams['client'],
  stateDir: string,
  state: RemoteConnectionState,
): Promise<boolean> {
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
  let released = false;
  let releaseError: string | undefined;
  if (state.leaseId) {
    try {
      const release = await releaseRemoteConnectionLease(client, state, flags.daemonAuthToken);
      released = release.released;
      providerData ??= release.provider;
    } catch (error) {
      // An inactive lease is already gone. Any other failure leaves a live lease whose only local
      // record is removed below, so the output must name it.
      if (!isInactiveLeaseError(error)) releaseError = errorMessage(error);
    }
  }
  removeRemoteConnectionState({ stateDir, session: connectedSession });
  // A failed release keeps the profile: retrying that release needs it.
  if (!releaseError) {
    removeGeneratedRemoteConfigIfUnused({ stateDir, remoteConfigPath: state.remoteConfigPath });
  }
  await writeCommandOutput(
    flags,
    {
      connected: false,
      session: connectedSession,
      released,
      ...(releaseError ? { leaseId: state.leaseId, releaseError } : {}),
      ...(providerData ? { provider: providerData } : {}),
    },
    () => renderDisconnectOutput(state, providerData, releaseError),
  );
  return true;
}

export const connectionCommand: ClientCommandHandler = async ({ positionals, flags, host }) => {
  if (positionals[0] !== 'status') {
    throw new AppError('INVALID_ARGS', 'connection accepts only: status');
  }
  const { session, state } = readRequestedConnectionState(flags, host);
  if (!state) {
    await writeNoRemoteConnectionOutput(flags, session);
    return true;
  }
  // Reading a stored record dispatches nothing, so a plugin this host lacks is not this command's
  // answer; the provider's declared capabilities come from the plugin when it is loaded, and from the
  // plugin catalog's copy of the declaration when it is not.
  await admitProviderForRoute(state.leaseProvider, 'reads-connection-record', host.env);
  const leasePreparation = buildLeasePreparationNotice(state, undefined, host.env);
  const runtimePreparation = buildRuntimePreparationNoticeFromState(state, host);
  await writeCommandOutput(
    flags,
    serializeConnectionState({ state, runtimePreparation, env: host.env }),
    () =>
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
  state: RemoteConnectionState,
  providerData: CloudProviderSessionResult | undefined,
  releaseError: string | undefined,
): string {
  return [
    `Disconnected remote session "${state.session}".`,
    ...(releaseError
      ? [
          `Could not release lease ${state.leaseId} (tenant ${state.tenant}, run ${state.runId}) ` +
            `at ${state.daemon?.baseUrl ?? 'its daemon'}: ${releaseError}. ` +
            'It was left in place — release it manually if it is still active.',
        ]
      : []),
    ...formatProviderReleaseWarnings(providerData),
    ...formatDeliveredArtifactLines(providerData?.cloudArtifacts),
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

function readRequestedConnectionState(
  flags: CliFlags,
  host: HostEnvironment,
): {
  session: string;
  state: RemoteConnectionState | null;
} {
  const session = flags.session ?? 'default';
  const stateDir = resolveConnectionStateDir(flags, host);
  // Only a caller that named no session follows the active-session pointer. `--session=` names the
  // empty session.
  const state =
    readRemoteConnectionState({ stateDir, session }) ??
    (flags.session === undefined ? readActiveConnectionState({ stateDir }) : null);
  if (state) requireLeasedConnectionSession(state, flags.session);
  return { session, state };
}

function resolveConnectionStateDir(flags: CliFlags, host: HostEnvironment): string {
  return resolveDaemonPaths(flags.stateDir, { cwd: host.cwd, env: host.env }).baseDir;
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
  if (!connectionPlatformMatchesSelection(state, options.flags.platform)) return false;
  const fieldsMatch = [
    [state.leaseBackend, options.desiredLeaseBackend],
    [state.target, options.flags.target],
  ].every(([left, right]) => right === undefined || left === right);
  return (
    fieldsMatch &&
    macosAppLeaseIdMatches(state, options.flags.leaseId) &&
    remoteConnectionLeaseIdentityMatches(state, options.connection)
  );
}

function macosAppLeaseIdMatches(
  state: RemoteConnectionState,
  leaseId: string | undefined,
): boolean {
  return state.leaseBackend !== 'macos-app' || leaseId === undefined || leaseId === state.leaseId;
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
  host: HostEnvironment,
): RuntimePreparationNotice | undefined {
  if (state.runtime) return undefined;
  if (
    !hasDeferredMetroConfig(flags) &&
    !remoteConfigHasMetroSettings(state.remoteConfigPath, host)
  ) {
    return undefined;
  }
  return buildDeferredRuntimeNotice(state);
}

function buildRuntimePreparationNoticeFromState(
  state: RemoteConnectionState,
  host: HostEnvironment,
): RuntimePreparationNotice | undefined {
  if (state.runtime || !remoteConfigHasMetroSettings(state.remoteConfigPath, host))
    return undefined;
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

function remoteConfigHasMetroSettings(remoteConfigPath: string, host: HostEnvironment): boolean {
  try {
    const remoteConfig = resolveRemoteConfigProfile({
      configPath: remoteConfigPath,
      cwd: host.cwd,
      env: host.env,
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
