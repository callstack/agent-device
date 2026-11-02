import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { resolveRemoteConfigProfile } from '@agent-device/remote/remote-config';
import {
  buildRemoteConnectionDaemonState,
  buildRemoteConnectionRequestMetadata,
  hashRemoteConfigFile,
  readRemoteConnectionState,
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
  connectionProviderCapabilities,
  primeProviderConnection,
} from '../connection/provider-policy.ts';
import { profileToCliFlags } from '../remote-config-flags.ts';
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

export async function materializeRemoteConnectionForCommand(options: {
  host: HostEnvironment;
  command: string;
  flags: CliFlags;
  client: AgentDeviceClient;
  runtime?: SessionRuntimeHints;
  positionals?: string[];
  batchSteps?: BatchStep[];
  forceRuntimePrepare?: boolean;
}): Promise<{
  flags: CliFlags;
  runtime?: SessionRuntimeHints;
  connection?: RemoteConnectionRequestMetadata;
  leaseDevice?: LeaseDevice;
}> {
  const { command, flags, client, host } = options;
  if (!flags.remoteConfig) {
    return { flags, runtime: options.runtime };
  }

  const stateDir = resolveDaemonPaths(flags.stateDir, {
    cwd: host.cwd,
    env: host.env,
  }).baseDir;
  const remoteConfig = resolveRemoteConfigProfile({
    configPath: flags.remoteConfig,
    cwd: host.cwd,
    env: host.env,
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

  await primeProviderConnection(providerOf(existingState, remoteConfig.profile));
  const state =
    existingState ??
    createRemoteConnectionStateFromFlags(
      mergedFlags,
      remoteConfig.resolvedPath,
      remoteConfig.profile,
    );
  const nextFlags = { ...mergedFlags, session: state.session };
  let nextRuntime = selectCompatibleRuntime(state.runtime, nextFlags.platform) ?? options.runtime;
  let nextState = state;
  let changed = !existingState;

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
      leaseId: nextState.leaseId,
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
  preparedMetroCleanupOnFailure?: RemoteConnectionState['metro'];
  metroCleanupToStop?: RemoteConnectionState['metro'];
}): Promise<void> {
  if (options.changed) {
    try {
      // The session record is the durable commit point: the moment it lands, it names the lease and
      // the ledger stops owning it. The active-pointer update that follows is a convenience reader
      // for the default session; its failure leaves the named lease owned by the record, not by us.
      writeRemoteConnectionState({
        stateDir: options.stateDir,
        state: options.state,
        onSessionRecordCommitted: () => options.leaseLedger.transfer(options.state.leaseId),
      });
    } catch (error) {
      // The caller's rollback ends any lease the record never came to name.
      await stopMetroCleanup(options.preparedMetroCleanupOnFailure);
      throw error;
    }
  }
  await stopMetroCleanup(options.metroCleanupToStop);
}

// A stored connection names its provider; before one exists, the remote config profile does.
function providerOf(
  existingState: Pick<RemoteConnectionState, 'leaseProvider'> | null | undefined,
  profile: Pick<RemoteConnectionState, 'leaseProvider'>,
): string | undefined {
  return existingState?.leaseProvider ?? profile.leaseProvider;
}

function createRemoteConnectionStateFromFlags(
  flags: CliFlags,
  remoteConfigPath: string,
  profile: Pick<RemoteConnectionState, 'leaseProvider' | 'clientId' | 'deviceKey'> = {},
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
  if (
    !flags.daemonBaseUrl &&
    connectionProviderCapabilities(profile.leaseProvider).requiresRemoteDaemon
  ) {
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
    leaseProvider: profile.leaseProvider,
    clientId: profile.clientId,
    deviceKey: profile.deviceKey,
    platform: flags.platform,
    target: flags.target,
    connectedAt: now,
    updatedAt: now,
  };
}
