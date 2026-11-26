import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  buildRemoteConnectionDaemonState,
  buildRemoteConnectionRequestMetadata,
  hashRemoteConfigFile,
  sessionLeaseScope,
  writeRemoteConnectionState,
  type RemoteConnectionRequestMetadata,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError } from '@agent-device/kernel/errors';
import type { BatchStep, LeaseDevice } from '@agent-device/contracts/client';
import type { SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import {
  admitProviderForRoute,
  connectionLeaseProvider,
  connectionProviderCapabilities,
  providerRouteForConnection,
} from '../connection/provider-policy.ts';
import {
  CLOUD_CONNECTION_REASONS,
  cloudConnectionUnavailable,
  readCloudConnection,
  withCloudConnectionOwner,
} from '../connection/cloud-connection-record.ts';
import {
  acquireConnectionLease,
  createLeaseLedger,
  resolveRequestedLeaseBackend,
  type LeaseLedger,
} from './connection-lease-transaction.ts';
import {
  prepareRuntimeForCommand,
  selectCompatibleRuntime,
  stopMetroCleanup,
} from './connection-metro-runtime.ts';
import { grantedLeaseDevice } from './proxy-lease-device.ts';
import type { CommandConnection } from '../connection/command-connection.ts';

type ConnectionSelection = {
  stateDir: string;
  state: RemoteConnectionState;
  existing: boolean;
};

export async function selectRemoteConnectionForCommand(
  connection: CommandConnection,
  flags: CliFlags,
  host: HostEnvironment,
): Promise<ConnectionSelection> {
  const { stateDir, storedState, remoteConfigPath, profile } = connection;
  if (storedState && storedState.remoteConfigPath !== remoteConfigPath) {
    throw new AppError(
      'INVALID_ARGS',
      'A different remote connection is already active for this session. Run connect --force or disconnect before using a different --remote-config.',
      {
        session: storedState.session,
        activeRemoteConfig: storedState.remoteConfigPath,
        requestedRemoteConfig: remoteConfigPath,
      },
    );
  }

  const provider = connectionLeaseProvider(storedState, profile.leaseProvider);
  await admitProviderForRoute(
    provider,
    providerRouteForConnection({ daemonBaseUrl: flags.daemonBaseUrl, env: host.env }),
    host.env,
  );
  const state = storedState
    ? { ...storedState, leaseProvider: provider }
    : createRemoteConnectionStateFromFlags(
        flags,
        remoteConfigPath,
        { ...profile, leaseProvider: provider },
        host.env,
      );
  return { stateDir, state, existing: storedState !== null };
}

export async function materializeRemoteConnectionForCommand(options: {
  host: HostEnvironment;
  command: string;
  flags: CliFlags;
  selection: ConnectionSelection;
  client: AgentDeviceClient;
  runtime?: SessionRuntimeHints;
  positionals?: string[];
  batchSteps?: BatchStep[];
  forceRuntimePrepare?: boolean;
  cloudGeneration?: string;
  hostedLease?: import('./connection-lease-policy.ts').HostedConnectionLease;
}): Promise<{
  flags: CliFlags;
  runtime?: SessionRuntimeHints;
  connection?: RemoteConnectionRequestMetadata;
  leaseDevice?: LeaseDevice;
}> {
  const { command, flags, client, host } = options;
  const { stateDir, state: savedState, existing } = options.selection;
  const hostedLeaseId = options.hostedLease?.id;
  const staleActiveLease =
    hostedLeaseId !== undefined &&
    savedState.leaseId !== undefined &&
    savedState.leaseId !== hostedLeaseId;
  const staleEndedLease =
    hostedLeaseId !== undefined &&
    savedState.endedLeaseId !== undefined &&
    savedState.endedLeaseId !== hostedLeaseId;
  const leaseChanged = staleActiveLease || staleEndedLease;
  const state = leaseChanged
    ? {
        ...savedState,
        leaseId: staleActiveLease ? undefined : savedState.leaseId,
        endedLeaseId: staleEndedLease ? undefined : savedState.endedLeaseId,
      }
    : savedState;
  const nextFlags = {
    ...flags,
    session: state.session,
    ...(hostedLeaseId === undefined ? {} : { leaseId: state.leaseId }),
  };
  let nextRuntime = selectCompatibleRuntime(state.runtime, nextFlags.platform) ?? options.runtime;
  let nextState = state;
  let changed = !existing;

  // Unknown creation evidence permits discard before binding, but only confirmed creation permits
  // rollback after a later failure. A committed session record takes over either lease.
  const leaseLedger = createLeaseLedger();
  try {
    const acquired = await acquireConnectionLease({
      command,
      client,
      state,
      nextFlags,
      positionals: options.positionals,
      leaseLedger,
      env: host.env,
      hostedLease: options.hostedLease,
    });
    nextState = acquired.state;
    changed = changed || acquired.changed;

    const runtimePreparation = await prepareRuntimeForCommand({
      command,
      flags: nextFlags,
      client,
      state,
      nextState,
      runtime: nextRuntime,
      positionals: options.positionals,
      batchSteps: options.batchSteps,
      forceRuntimePrepare: options.forceRuntimePrepare,
    });
    nextState = runtimePreparation.state;
    nextRuntime = runtimePreparation.runtime;
    changed = changed || runtimePreparation.changed;
    await persistMaterializedConnection({
      changed,
      stateDir,
      state: nextState,
      leaseLedger,
      cloudGeneration: options.cloudGeneration,
      hosted: options.hostedLease !== undefined,
      preparedMetroCleanupOnFailure: runtimePreparation.preparedMetroCleanupOnFailure,
      metroCleanupToStop: runtimePreparation.metroCleanupToStop,
    });
  } catch (error) {
    throw await leaseLedger.releaseOwnedOnFailure(error);
  }

  return {
    flags: {
      ...nextFlags,
      session: nextState.session,
      leaseId: nextState.leaseId ?? (command === 'artifacts' ? nextState.endedLeaseId : undefined),
      leaseBackend: nextState.leaseBackend,
      platform: nextState.platform ?? nextFlags.platform,
      target: nextState.target ?? nextFlags.target,
    },
    runtime: nextRuntime,
    connection: buildRemoteConnectionRequestMetadata(nextState),
    leaseDevice: grantedLeaseDevice(nextState),
  };
}

async function persistMaterializedConnection(options: {
  changed: boolean;
  stateDir: string;
  state: RemoteConnectionState;
  leaseLedger: LeaseLedger;
  cloudGeneration?: string;
  hosted: boolean;
  preparedMetroCleanupOnFailure?: RemoteConnectionState['metro'];
  metroCleanupToStop?: RemoteConnectionState['metro'];
}): Promise<void> {
  if (options.changed) {
    try {
      // The session record is the durable commit point: the moment it lands, it names the lease and
      // the ledger stops owning it. The active-pointer update that follows is a convenience reader
      // for the default session; its failure leaves the named lease owned by the record, not by us.
      const location = { stateDir: options.stateDir, session: options.state.session };
      await withCloudConnectionOwner(location, options.cloudGeneration, () => {
        if (
          options.hosted &&
          options.state.leaseId &&
          readCloudConnection(location)?.hostedLeaseId !== options.state.leaseId
        ) {
          throw cloudConnectionUnavailable(CLOUD_CONNECTION_REASONS.changed.reason);
        }
        writeRemoteConnectionState({
          stateDir: options.stateDir,
          state: options.state,
          onSessionRecordCommitted: () => options.leaseLedger.transfer(options.state.leaseId),
        });
      });
    } catch (error) {
      // The caller's rollback ends any lease the record never came to name.
      await stopMetroCleanup(options.preparedMetroCleanupOnFailure);
      throw error;
    }
  }
  await stopMetroCleanup(options.metroCleanupToStop);
}

function createRemoteConnectionStateFromFlags(
  flags: CliFlags,
  remoteConfigPath: string,
  profile: Partial<
    Pick<RemoteConnectionState, 'leaseProvider' | 'clientId' | 'deviceKey' | 'runId'>
  >,
  env: NodeJS.ProcessEnv,
): RemoteConnectionState {
  const session = flags.session ?? 'default';
  const scope = sessionLeaseScope(
    { ...profile, leaseId: flags.leaseId, runId: profile.runId },
    session,
  );
  // A run the caller passed with --run-id is theirs to share; only the profile's run is per session.
  const runId = flags.runId === profile.runId ? scope.runId : flags.runId;
  const clientId = scope.clientId;
  if (!flags.tenant) {
    throw new AppError(
      'INVALID_ARGS',
      'remote command requires tenant in remote config or via --tenant <id>.',
    );
  }
  if (!runId) {
    throw new AppError(
      'INVALID_ARGS',
      'remote command requires runId in remote config or via --run-id <id>.',
    );
  }
  if (
    !flags.daemonBaseUrl &&
    connectionProviderCapabilities(profile.leaseProvider, env).requiresRemoteDaemon
  ) {
    throw new AppError(
      'INVALID_ARGS',
      'remote command requires daemonBaseUrl in remote config, config, env, or --daemon-base-url.',
    );
  }
  const now = new Date().toISOString();
  return {
    version: 1,
    session,
    remoteConfigPath,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon: buildRemoteConnectionDaemonState(flags),
    tenant: flags.tenant,
    runId,
    leaseId: flags.leaseId,
    leaseBackend: flags.leaseBackend ?? resolveRequestedLeaseBackend(flags),
    leaseProvider: profile.leaseProvider,
    clientId,
    deviceKey: profile.deviceKey,
    platform: flags.platform,
    target: flags.target,
    connectedAt: now,
    updatedAt: now,
  };
}
