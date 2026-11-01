import { isSessionRuntimePlatform, type SessionRuntimeHints } from '@agent-device/kernel/contracts';
import { readMetroPrepareKind, type AgentDeviceClient } from '@agent-device/command-surface';
import { AppError } from '@agent-device/kernel/errors';
import { stopMetroTunnel } from '@agent-device/react-native';
import type { BatchStep } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import type { MetroBridgeScope } from '@agent-device/contracts/remote';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { shouldAgentCdpUseRemoteBridgeUrl } from './agent-cdp.ts';

const runtimeDeferredCommands = new Set(['open']);

export async function prepareRuntimeForCommand(options: {
  command: string;
  flags: CliFlags;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  nextState: RemoteConnectionState;
  runtime?: SessionRuntimeHints;
  positionals?: string[];
  batchSteps?: BatchStep[];
  forceRuntimePrepare?: boolean;
}): Promise<{
  state: RemoteConnectionState;
  runtime?: SessionRuntimeHints;
  changed: boolean;
  metroCleanupToStop?: RemoteConnectionState['metro'];
  preparedMetroCleanupOnFailure?: RemoteConnectionState['metro'];
}> {
  const { command, flags, state, client } = options;
  let nextState = ensureRuntimeLeaseState(options.nextState, flags);
  const nextRuntime = options.runtime;
  if (
    !shouldPrepareRuntimeForCommand(command, flags, options.batchSteps, options.positionals) ||
    !hasDeferredMetroConfig(flags) ||
    !shouldPrepareRuntime(options.forceRuntimePrepare, nextRuntime, flags.platform)
  ) {
    return { state: nextState, runtime: nextRuntime, changed: false };
  }
  if (!nextState.leaseId) {
    throw new AppError(
      'INVALID_ARGS',
      `${command} requires a resolved remote lease before Metro runtime can be prepared.`,
    );
  }
  const prepared = await prepareConnectedMetro(
    flags,
    client,
    state.remoteConfigPath,
    state.session,
    {
      tenantId: state.tenant,
      runId: state.runId,
      leaseId: nextState.leaseId,
    },
  );
  const replacesExistingMetroCleanup = !isSameMetroCleanup(nextState.metro, prepared.cleanup);
  nextState = {
    ...nextState,
    runtime: prepared.runtime,
    metro: prepared.cleanup,
    updatedAt: new Date().toISOString(),
  };
  return {
    state: nextState,
    runtime: prepared.runtime,
    changed: true,
    metroCleanupToStop: replacesExistingMetroCleanup ? options.nextState.metro : undefined,
    preparedMetroCleanupOnFailure: replacesExistingMetroCleanup ? prepared.cleanup : undefined,
  };
}

function ensureRuntimeLeaseState(
  state: RemoteConnectionState,
  flags: CliFlags,
): RemoteConnectionState {
  if (state.leaseId || !flags.leaseId) return state;
  return {
    ...state,
    leaseId: flags.leaseId,
    leaseBackend: flags.leaseBackend,
  };
}

function shouldPrepareRuntime(
  forceRuntimePrepare: boolean | undefined,
  runtime: SessionRuntimeHints | undefined,
  platform: CliFlags['platform'],
): boolean {
  return (
    forceRuntimePrepare === true || !runtime || !isRuntimeCompatibleWithPlatform(runtime, platform)
  );
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
    kind: readMetroPrepareKind(flags.metroKind),
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
  if (!runtime.platform || !platform || !isSessionRuntimePlatform(platform)) {
    return true;
  }
  return runtime.platform === platform;
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

export function selectCompatibleRuntime(
  runtime: SessionRuntimeHints | undefined,
  platform: CliFlags['platform'],
): SessionRuntimeHints | undefined {
  if (!runtime) return undefined;
  return isRuntimeCompatibleWithPlatform(runtime, platform) ? runtime : undefined;
}
