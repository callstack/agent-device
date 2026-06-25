import { resolveDaemonPaths } from '../../daemon/config.ts';
import { stopReactDevtoolsCompanion } from '../../client-react-devtools-companion.ts';
import { stopMetroTunnel } from '../../metro.ts';
import { resolveRemoteConfigProfile } from '../../remote-config.ts';
import { shouldAgentCdpUseRemoteBridgeUrl } from './agent-cdp.ts';
import type { MetroBridgeScope } from '../../client-companion-tunnel-contract.ts';
import {
  buildRemoteConnectionDaemonState,
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '../../remote-connection-state.ts';
import { profileToCliFlags } from '../../utils/remote-config.ts';
import type { BatchStep } from '../../client-types.ts';
import { AppError } from '../../utils/errors.ts';
import type { LeaseBackend, SessionRuntimeHints } from '../../contracts.ts';
import type { CliFlags } from '../../utils/cli-flags.ts';
import type { AgentDeviceClient, Lease } from '../../client.ts';
import type { MetroPrepareKind } from '../../client-metro.ts';

const leaseDeferredCommands = new Set([
  'connect',
  'connection',
  'close',
  'disconnect',
  'metro',
  'session',
]);
const runtimeDeferredCommands = new Set(['open']);

export async function materializeRemoteConnectionForCommand(options: {
  command: string;
  flags: CliFlags;
  client: AgentDeviceClient;
  runtime?: SessionRuntimeHints;
  positionals?: string[];
  batchSteps?: BatchStep[];
  forceRuntimePrepare?: boolean;
}): Promise<{ flags: CliFlags; runtime?: SessionRuntimeHints }> {
  const { command, flags, client } = options;
  if (!flags.remoteConfig) {
    return { flags, runtime: options.runtime };
  }

  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  const remoteConfig = resolveRemoteConfigProfile({
    configPath: flags.remoteConfig,
    cwd: process.cwd(),
    env: process.env,
  });
  const profileFlags = profileToCliFlags(remoteConfig.profile);
  const mergedFlags = {
    ...profileFlags,
    ...flags,
    remoteConfig: remoteConfig.resolvedPath,
  };
  const existingState = readRemoteConnectionState({
    stateDir,
    session: mergedFlags.session ?? 'default',
  });
  if (existingState && existingState.remoteConfigPath !== remoteConfig.resolvedPath) {
    throw new AppError(
      'INVALID_ARGS',
      'A different remote connection is already active for this session. Run connect --force or disconnect before using a different --remote-config.',
      {
        session: existingState.session,
        activeRemoteConfig: existingState.remoteConfigPath,
        requestedRemoteConfig: remoteConfig.resolvedPath,
      },
    );
  }

  const state =
    existingState ?? createRemoteConnectionStateFromFlags(mergedFlags, remoteConfig.resolvedPath);
  const nextFlags = { ...mergedFlags, session: state.session };
  let nextRuntime = selectCompatibleRuntime(state.runtime, nextFlags.platform) ?? options.runtime;
  let nextState = state;
  let changed = !existingState;
  let metroCleanupToStop: RemoteConnectionState['metro'] | undefined;
  let preparedMetroCleanupOnFailure: RemoteConnectionState['metro'] | undefined;

  if (shouldAllocateLeaseForCommand(command)) {
    const leaseBackend = state.leaseBackend ?? requireRequestedLeaseBackend(flags, command);
    assertRequestedConnectionScope(state, flags, leaseBackend);
    const lease = await allocateOrReuseLease(client, nextState, leaseBackend);
    nextFlags.leaseId = lease.leaseId;
    nextFlags.leaseBackend = leaseBackend;
    nextFlags.platform = nextState.platform ?? nextFlags.platform;
    nextFlags.target = nextState.target ?? nextFlags.target;
    if (nextState.leaseId !== lease.leaseId || nextState.leaseBackend !== leaseBackend) {
      nextState = {
        ...nextState,
        leaseId: lease.leaseId,
        leaseBackend,
        platform: nextState.platform ?? flags.platform,
        target: nextState.target ?? flags.target,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }
  }

  if (
    shouldPrepareRuntimeForCommand(command, nextFlags, options.batchSteps, options.positionals) &&
    hasDeferredMetroConfig(nextFlags)
  ) {
    if (!nextState.leaseId && nextFlags.leaseId) {
      nextState = {
        ...nextState,
        leaseId: nextFlags.leaseId,
        leaseBackend: nextFlags.leaseBackend,
      };
    }
    const requiresPreparedRuntime =
      options.forceRuntimePrepare ||
      !nextRuntime ||
      !isRuntimeCompatibleWithPlatform(nextRuntime, nextFlags.platform);
    if (requiresPreparedRuntime) {
      if (!nextState.leaseId) {
        throw new AppError(
          'INVALID_ARGS',
          `${command} requires a resolved remote lease before Metro runtime can be prepared.`,
        );
      }
      const prepared = await prepareConnectedMetro(
        nextFlags,
        client,
        state.remoteConfigPath,
        state.session,
        {
          tenantId: state.tenant,
          runId: state.runId,
          leaseId: nextState.leaseId,
        },
      );
      nextRuntime = prepared.runtime;
      const replacesExistingMetroCleanup = !isSameMetroCleanup(nextState.metro, prepared.cleanup);
      metroCleanupToStop = replacesExistingMetroCleanup ? nextState.metro : undefined;
      preparedMetroCleanupOnFailure = replacesExistingMetroCleanup ? prepared.cleanup : undefined;
      nextState = {
        ...nextState,
        runtime: prepared.runtime,
        metro: prepared.cleanup,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    }
  }

  if (changed) {
    try {
      writeRemoteConnectionState({ stateDir, state: nextState });
    } catch (error) {
      await stopMetroCleanup(preparedMetroCleanupOnFailure);
      throw error;
    }
  }
  await stopMetroCleanup(metroCleanupToStop);

  return {
    flags: {
      ...nextFlags,
      session: nextState.session,
      leaseId: nextState.leaseId,
      leaseBackend: nextState.leaseBackend,
      platform: nextState.platform ?? nextFlags.platform,
      target: nextState.target ?? nextFlags.target,
    },
    runtime: nextRuntime,
  };
}

async function prepareConnectedMetro(
  flags: CliFlags,
  client: AgentDeviceClient,
  remoteConfigPath: string,
  session: string,
  bridgeScope: MetroBridgeScope,
): Promise<{
  runtime?: SessionRuntimeHints;
  cleanup?: NonNullable<RemoteConnectionState['metro']>;
}> {
  if (!flags.metroProjectRoot && !flags.metroPublicBaseUrl && !flags.metroProxyBaseUrl) {
    return {};
  }
  if (flags.platform !== 'ios' && flags.platform !== 'android') {
    throw new AppError(
      'INVALID_ARGS',
      'Deferred Metro preparation requires platform "ios" or "android".',
    );
  }
  if (!flags.metroPublicBaseUrl && !flags.metroProxyBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'Deferred Metro preparation requires metroPublicBaseUrl or metroProxyBaseUrl when Metro settings are provided.',
    );
  }
  const prepared = await client.metro.prepare({
    projectRoot: flags.metroProjectRoot,
    kind: readDeferredMetroKind(flags.metroKind),
    publicBaseUrl: flags.metroPublicBaseUrl,
    proxyBaseUrl: flags.metroProxyBaseUrl,
    bearerToken: flags.metroBearerToken,
    bridgeScope,
    launchUrl: flags.launchUrl,
    companionProfileKey: remoteConfigPath,
    companionConsumerKey: session,
    port: flags.metroPreparePort,
    listenHost: flags.metroListenHost,
    statusHost: flags.metroStatusHost,
    startupTimeoutMs: flags.metroStartupTimeoutMs,
    probeTimeoutMs: flags.metroProbeTimeoutMs,
    reuseExisting: flags.metroNoReuseExisting ? false : undefined,
    installDependenciesIfNeeded: flags.metroNoInstallDeps ? false : undefined,
    runtimeFilePath: flags.metroRuntimeFile,
  });
  return {
    runtime: flags.platform === 'ios' ? prepared.iosRuntime : prepared.androidRuntime,
    cleanup: flags.metroProxyBaseUrl
      ? {
          projectRoot: prepared.projectRoot,
          profileKey: remoteConfigPath,
          consumerKey: session,
        }
      : undefined,
  };
}

export async function stopMetroCleanup(
  cleanup: RemoteConnectionState['metro'] | undefined,
): Promise<void> {
  if (!cleanup) return;
  try {
    await stopMetroTunnel(cleanup);
  } catch {
    // Connection lifecycle cleanup must stay best-effort.
  }
}

export async function stopReactDevtoolsCleanup(options: {
  stateDir: string;
  state: Pick<RemoteConnectionState, 'remoteConfigPath' | 'session'>;
}): Promise<void> {
  try {
    await stopReactDevtoolsCompanion({
      projectRoot: process.cwd(),
      stateDir: options.stateDir,
      profileKey: options.state.remoteConfigPath,
      consumerKey: options.state.session,
    });
  } catch {
    // Connection lifecycle cleanup must stay best-effort.
  }
}

export async function releasePreviousLease(
  client: AgentDeviceClient,
  previous: RemoteConnectionState,
): Promise<void> {
  if (!previous.leaseId) return;
  try {
    await client.leases.release({
      tenant: previous.tenant,
      runId: previous.runId,
      leaseId: previous.leaseId,
      daemonBaseUrl: previous.daemon?.baseUrl,
      daemonTransport: previous.daemon?.transport,
      daemonServerMode: previous.daemon?.serverMode,
    });
  } catch {
    // Reconnect must succeed even if the old lease was already released.
  }
}

export function resolveRequestedLeaseBackend(flags: CliFlags): LeaseBackend | undefined {
  if (flags.leaseBackend) return flags.leaseBackend;
  if (flags.platform === 'android') return 'android-instance';
  if (flags.platform === 'ios') return 'ios-instance';
  return undefined;
}

function requireRequestedLeaseBackend(flags: CliFlags, command: string): LeaseBackend {
  const leaseBackend = resolveRequestedLeaseBackend(flags);
  if (leaseBackend) return leaseBackend;
  throw new AppError(
    'INVALID_ARGS',
    `${command} requires --platform ios|android or --lease-backend when the remote connection has not resolved a lease yet.`,
  );
}

function shouldAllocateLeaseForCommand(command: string): boolean {
  return !leaseDeferredCommands.has(command);
}

function shouldPrepareRuntimeForCommand(
  command: string,
  flags: CliFlags,
  batchSteps?: BatchStep[],
  positionals: string[] = [],
): boolean {
  if (command === 'cdp') {
    return shouldAgentCdpUseRemoteBridgeUrl(positionals) && Boolean(flags.metroPublicBaseUrl);
  }
  if (runtimeDeferredCommands.has(command)) {
    return true;
  }
  if (command !== 'batch' || !batchSteps) {
    return false;
  }
  return batchSteps.some((step) => {
    const stepCommand = step.command.trim().toLowerCase();
    return runtimeDeferredCommands.has(stepCommand) && step.runtime === undefined;
  });
}

export function hasDeferredMetroConfig(flags: CliFlags): boolean {
  const metroKind = flags.metroKind;
  return Boolean(
    flags.metroPublicBaseUrl || flags.metroProxyBaseUrl || flags.metroProjectRoot || metroKind,
  );
}

function isRuntimeCompatibleWithPlatform(
  runtime: SessionRuntimeHints,
  platform: CliFlags['platform'],
): boolean {
  if (!runtime.platform || !platform || (platform !== 'ios' && platform !== 'android')) {
    return true;
  }
  return runtime.platform === platform;
}

function readDeferredMetroKind(value: string | undefined): MetroPrepareKind | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'react-native' || value === 'expo') return value;
  throw new AppError('INVALID_ARGS', 'metro prepare --kind must be auto, react-native, or expo');
}

function isSameMetroCleanup(
  left: RemoteConnectionState['metro'] | undefined,
  right: RemoteConnectionState['metro'] | undefined,
): boolean {
  return (
    left?.projectRoot === right?.projectRoot &&
    left?.profileKey === right?.profileKey &&
    left?.consumerKey === right?.consumerKey
  );
}

function selectCompatibleRuntime(
  runtime: SessionRuntimeHints | undefined,
  platform: CliFlags['platform'],
): SessionRuntimeHints | undefined {
  if (!runtime) return undefined;
  return isRuntimeCompatibleWithPlatform(runtime, platform) ? runtime : undefined;
}

function createRemoteConnectionStateFromFlags(
  flags: CliFlags,
  remoteConfigPath: string,
): RemoteConnectionState {
  if (!flags.tenant) {
    throw new AppError(
      'INVALID_ARGS',
      'remote command requires tenant in remote config or via --tenant <id>.',
    );
  }
  if (!flags.runId) {
    throw new AppError(
      'INVALID_ARGS',
      'remote command requires runId in remote config or via --run-id <id>.',
    );
  }
  if (!flags.daemonBaseUrl) {
    throw new AppError(
      'INVALID_ARGS',
      'remote command requires daemonBaseUrl in remote config, config, env, or --daemon-base-url.',
    );
  }
  const now = new Date().toISOString();
  return {
    version: 1,
    session: flags.session ?? 'default',
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon: buildRemoteConnectionDaemonState(flags),
    tenant: flags.tenant,
    runId: flags.runId,
    leaseId: flags.leaseId,
    leaseBackend: flags.leaseBackend ?? resolveRequestedLeaseBackend(flags),
    platform: flags.platform,
    target: flags.target,
    connectedAt: now,
    updatedAt: now,
  };
}

async function allocateOrReuseLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  leaseBackend: LeaseBackend,
): Promise<Lease> {
  if (state.leaseId && state.leaseBackend === leaseBackend) {
    const existing = await heartbeatOrAllocateLease(client, state.leaseId, {
      tenant: state.tenant,
      runId: state.runId,
      leaseBackend,
    });
    if (existing) return existing;
  }
  return await client.leases.allocate({
    tenant: state.tenant,
    runId: state.runId,
    leaseBackend,
  });
}

function assertRequestedConnectionScope(
  state: RemoteConnectionState,
  flags: CliFlags,
  requestedLeaseBackend: LeaseBackend,
): void {
  if (state.leaseBackend && state.leaseBackend !== requestedLeaseBackend) {
    throw new AppError(
      'INVALID_ARGS',
      'Active remote connection is already bound to a different lease backend. Re-run connect --force to replace it.',
      { session: state.session, leaseBackend: state.leaseBackend },
    );
  }
  if (state.platform && flags.platform && state.platform !== flags.platform) {
    throw new AppError(
      'INVALID_ARGS',
      'Active remote connection is already bound to a different platform. Re-run connect --force to replace it.',
      { session: state.session, platform: state.platform },
    );
  }
  if (state.target && flags.target && state.target !== flags.target) {
    throw new AppError(
      'INVALID_ARGS',
      'Active remote connection is already bound to a different target. Re-run connect --force to replace it.',
      { session: state.session, target: state.target },
    );
  }
}

async function heartbeatOrAllocateLease(
  client: AgentDeviceClient,
  leaseId: string,
  scope: { tenant: string; runId: string; leaseBackend: LeaseBackend },
): Promise<Lease | undefined> {
  try {
    return await client.leases.heartbeat({
      tenant: scope.tenant,
      runId: scope.runId,
      leaseId,
      leaseBackend: scope.leaseBackend,
    });
  } catch (error) {
    if (isInactiveLeaseError(error)) return undefined;
    throw error;
  }
}

function isInactiveLeaseError(error: unknown): boolean {
  if (!(error instanceof AppError) || error.code !== 'UNAUTHORIZED') return false;
  return (
    error.details?.reason === 'LEASE_NOT_FOUND' ||
    error.details?.reason === 'LEASE_EXPIRED' ||
    error.details?.reason === 'LEASE_REVOKED'
  );
}
