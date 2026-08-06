import type { MetroBridgeScope } from '@agent-device/contracts/remote';
import { resolveDaemonPaths } from '../../daemon/config.ts';
import { stopReactDevtoolsCompanion } from '../../client/client-react-devtools-companion.ts';
import { stopMetroTunnel } from '../../metro/metro.ts';
import { resolveRemoteConfigProfile } from '../../remote/remote-config.ts';
// Provenance-preserving file-only read (no ambient env defaults merged in) —
// see resolvePreviousOwnDaemonAuthToken below for why this must not be
// resolveRemoteConfigProfile.
import { readRemoteConfigFile } from '../../remote/remote-config-core.ts';
import {
  deviceFieldsFromPublicPlatform,
  isIosFamily,
  publicPlatformString,
  resolveDevice,
  type DeviceInfo,
} from '@agent-device/kernel/device';
import { shouldAgentCdpUseRemoteBridgeUrl } from './agent-cdp.ts';
import {
  buildRemoteConnectionDaemonState,
  buildRemoteConnectionRequestMetadata,
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
  type RemoteConnectionRequestMetadata,
} from '../../remote/remote-connection-state.ts';
import { profileToCliFlags } from '../remote-config-flags.ts';
import type { BatchStep } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import type { LeaseBackend, SessionRuntimeHints } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient, Lease } from '../../agent-device-client.ts';
import type { CloudProviderSessionResult } from '@agent-device/contracts/observability';
import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { readMetroPrepareKind } from '../../commands/metro/prepare-kind.ts';
import { connectionProviderRequiresRemoteDaemon } from '../connection/provider-policy.ts';
import { readCloudDeviceFeatureProfileFields } from '../connection/profile-fields.ts';
import { isCloudWebDriverProviderName } from '@agent-device/provider-webdriver';
import type { PreviousLeaseReleaseNotice } from './connection-presentation.ts';

const leaseDeferredCommands = new Set([
  'artifacts',
  'connect',
  'connection',
  'close',
  'disconnect',
  'metro',
  'session',
]);
const runtimeDeferredCommands = new Set(['open']);
const proxyLeaseAllocatingCommands: ReadonlySet<string> = new Set([
  PUBLIC_COMMANDS.open,
  PUBLIC_COMMANDS.install,
  PUBLIC_COMMANDS.reinstall,
  INTERNAL_COMMANDS.installSource,
]);
export const PROXY_REMOTE_LEASE_TTL_MS = 5 * 60 * 1000;
export const CLOUD_WEBDRIVER_REMOTE_LEASE_TTL_MS = 10 * 60 * 1000;

export async function materializeRemoteConnectionForCommand(options: {
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
}> {
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
  let acquiredLeaseForCleanup: Lease | undefined;

  const leasePolicy = connectionLeasePolicyForState(nextState);
  if (leasePolicy.shouldAllocate(command)) {
    const materializedLease = await materializeLeaseForCommand({
      command,
      client,
      state,
      nextState,
      nextFlags,
      policy: leasePolicy,
    });
    nextState = materializedLease.state;
    changed = changed || materializedLease.changed;
    acquiredLeaseForCleanup = materializedLease.acquiredLeaseForCleanup;
  }

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
    client,
    acquiredLeaseForCleanup,
    preparedMetroCleanupOnFailure: runtimePreparation.preparedMetroCleanupOnFailure,
    metroCleanupToStop: runtimePreparation.metroCleanupToStop,
  });

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
  };
}

async function prepareRuntimeForCommand(options: {
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

async function persistMaterializedConnection(options: {
  changed: boolean;
  stateDir: string;
  state: RemoteConnectionState;
  client: AgentDeviceClient;
  acquiredLeaseForCleanup?: Lease;
  preparedMetroCleanupOnFailure?: RemoteConnectionState['metro'];
  metroCleanupToStop?: RemoteConnectionState['metro'];
}): Promise<void> {
  if (options.changed) {
    try {
      writeRemoteConnectionState({ stateDir: options.stateDir, state: options.state });
    } catch (error) {
      await stopMetroCleanup(options.preparedMetroCleanupOnFailure);
      await releaseAcquiredLeaseOnWriteFailure(
        options.client,
        options.state,
        options.acquiredLeaseForCleanup,
      );
      throw error;
    }
  }
  await stopMetroCleanup(options.metroCleanupToStop);
}

async function materializeLeaseForCommand(options: {
  command: string;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  nextState: RemoteConnectionState;
  nextFlags: CliFlags;
  policy: ConnectionLeasePolicy;
}): Promise<{
  state: RemoteConnectionState;
  changed: boolean;
  acquiredLeaseForCleanup?: Lease;
}> {
  const { command, client, state, nextFlags, policy } = options;
  const preliminaryLeaseBackend = state.leaseBackend ?? resolveRequestedLeaseBackend(nextFlags);
  let nextState = options.nextState;
  const resolvedLeaseState = await policy.resolveLeaseState({
    command,
    client,
    state: nextState,
    flags: nextFlags,
    leaseBackend: preliminaryLeaseBackend,
  });
  nextState = resolvedLeaseState.state;
  if (resolvedLeaseState.device) {
    applyResolvedDeviceSelector(nextFlags, resolvedLeaseState.device);
  }
  const leaseBackend =
    nextState.leaseBackend ??
    preliminaryLeaseBackend ??
    requireRequestedLeaseBackend(nextFlags, command);
  assertRequestedConnectionScope(state, nextFlags, leaseBackend);
  const materializedLease = await allocateOrReuseLease(
    client,
    nextState,
    leaseBackend,
    policy,
    nextFlags,
  );
  const lease = materializedLease.lease;
  nextFlags.leaseId = lease.leaseId;
  nextFlags.leaseBackend = leaseBackend;
  nextFlags.platform = nextState.platform ?? nextFlags.platform;
  nextFlags.target = nextState.target ?? nextFlags.target;
  if (leaseStateMatches(nextState, lease, leaseBackend)) {
    return {
      state: nextState,
      changed: false,
      acquiredLeaseForCleanup: materializedLease.acquired ? lease : undefined,
    };
  }
  return {
    state: buildMaterializedLeaseState(nextState, lease, leaseBackend, nextFlags),
    changed: true,
    acquiredLeaseForCleanup: materializedLease.acquired ? lease : undefined,
  };
}

function leaseStateMatches(
  state: RemoteConnectionState,
  lease: Lease,
  leaseBackend: LeaseBackend,
): boolean {
  return (
    state.leaseId === lease.leaseId &&
    state.leaseBackend === leaseBackend &&
    state.deviceKey === (lease.deviceKey ?? state.deviceKey)
  );
}

function buildMaterializedLeaseState(
  state: RemoteConnectionState,
  lease: Lease,
  leaseBackend: LeaseBackend,
  flags: CliFlags,
): RemoteConnectionState {
  return {
    ...state,
    leaseId: lease.leaseId,
    leaseBackend,
    leaseProvider: lease.leaseProvider ?? state.leaseProvider,
    clientId: lease.clientId ?? state.clientId,
    deviceKey: lease.deviceKey ?? state.deviceKey,
    platform: state.platform ?? flags.platform,
    target: state.target ?? flags.target,
    updatedAt: new Date().toISOString(),
  };
}

type ConnectionLeasePolicy = {
  shouldAllocate(command: string): boolean;
  ttlMs(state: RemoteConnectionState): number | undefined;
  resolveLeaseState(options: {
    command: string;
    client: AgentDeviceClient;
    state: RemoteConnectionState;
    flags: CliFlags;
    leaseBackend?: LeaseBackend;
  }): Promise<{ state: RemoteConnectionState; device?: DeviceInfo }>;
};

function connectionLeasePolicyForState(state: RemoteConnectionState): ConnectionLeasePolicy {
  if (state.leaseProvider === 'proxy') return PROXY_CONNECTION_LEASE_POLICY;
  if (isCloudWebDriverProviderName(state.leaseProvider)) {
    return CLOUD_WEBDRIVER_CONNECTION_LEASE_POLICY;
  }
  return DEFAULT_CONNECTION_LEASE_POLICY;
}

const DEFAULT_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) => !leaseDeferredCommands.has(command),
  ttlMs: () => undefined,
  resolveLeaseState: async (options) => ({ state: options.state }),
};

const PROXY_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) => command !== 'devices' && !leaseDeferredCommands.has(command),
  ttlMs: () => PROXY_REMOTE_LEASE_TTL_MS,
  resolveLeaseState: resolveProxyLeaseState,
};

const CLOUD_WEBDRIVER_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) => !leaseDeferredCommands.has(command),
  ttlMs: () => CLOUD_WEBDRIVER_REMOTE_LEASE_TTL_MS,
  resolveLeaseState: async (options) => ({ state: options.state }),
};

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

export async function releaseRemoteConnectionLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  // The daemon bearer token is never persisted on `state` (ADR 0007); callers
  // pass the token already resolved via the flag/env/CLI-session chain.
  daemonAuthToken?: string,
): Promise<{ released: boolean; provider?: CloudProviderSessionResult }> {
  if (!state.leaseId) return { released: false };
  const result = await client.leases.release({
    tenant: state.tenant,
    runId: state.runId,
    leaseId: state.leaseId,
    leaseBackend: state.leaseBackend,
    daemonBaseUrl: state.daemon?.baseUrl,
    daemonAuthToken,
    daemonTransport: state.daemon?.transport,
    daemonServerMode: state.daemon?.serverMode,
    leaseProvider: state.leaseProvider,
    clientId: state.clientId,
    deviceKey: state.deviceKey,
  });
  return result;
}

// A forced reconnect releases the *previous* connection's lease, which must be
// authenticated against the *previous* endpoint's own credential — never the
// new connection's token (that would send an unrelated endpoint's secret to
// an endpoint it was never issued for). See plans/007 for the full rule.
type PreviousLeaseAuthResolution =
  | { canAuthenticate: true; daemonAuthToken?: string }
  | { canAuthenticate: false };

function resolvePreviousLeaseAuth(options: {
  previous: RemoteConnectionState;
  nextDaemonBaseUrl?: string;
  ambientDaemonAuthToken?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): PreviousLeaseAuthResolution {
  const ownToken = resolvePreviousOwnDaemonAuthToken(options.previous, options.cwd, options.env);
  if (ownToken) return { canAuthenticate: true, daemonAuthToken: ownToken };
  if (options.previous.daemon?.baseUrl === options.nextDaemonBaseUrl) {
    // Same endpoint: the ambient credential plausibly belongs to it too.
    return { canAuthenticate: true, daemonAuthToken: options.ambientDaemonAuthToken };
  }
  return { canAuthenticate: false };
}

function resolvePreviousOwnDaemonAuthToken(
  previous: RemoteConnectionState,
  cwd: string,
  env: Record<string, string | undefined>,
): string | undefined {
  try {
    // readRemoteConfigFile, not resolveRemoteConfigProfile: the latter merges
    // ambient environment defaults (e.g. AGENT_DEVICE_DAEMON_AUTH_TOKEN) into
    // the profile, which would let the *new* connection's env-sourced token
    // masquerade as a credential that provably belongs to the *previous*
    // endpoint. Only a token the previous config file itself declares counts
    // here; the env fallback is rule 2's job, gated on matching endpoints.
    const { profile } = readRemoteConfigFile({
      configPath: previous.remoteConfigPath,
      cwd,
      env,
    });
    if (!profile.daemonAuthToken) return undefined;
    // The path alone is not provenance. `remoteConfigPath` names a file *now*,
    // while the claim being made is about what that file declared when the
    // previous connection was established — and a config path is routinely
    // reused (edited in place, re-pointed at a second environment) between the
    // two. Without this check, "connect to A from ./remote.json, re-point
    // ./remote.json at B, connect --force" reads B's token as A's own and
    // sends it to A during lease release: the same cross-endpoint leak the
    // env-merge fix closed, arriving through the file instead.
    return previousConfigStillSpeaksForPreviousEndpoint(previous, profile.daemonBaseUrl)
      ? profile.daemonAuthToken
      : undefined;
  } catch {
    // A missing/unparseable previous config is the "cannot authenticate"
    // case handled by the caller, not an error to propagate here.
    return undefined;
  }
}

/**
 * Whether the previous connection's config file can still vouch for a token as
 * belonging to the previous connection's endpoint.
 *
 * The file must explicitly declare the same endpoint recorded in the previous
 * connection state. A matching file hash proves only that the file itself did
 * not change; it does not prove that its endpoint/token were effective when
 * CLI flags may have overridden them. Endpoint equality is the provenance
 * boundary and also preserves the benign rotated-credential case.
 *
 * The endpoint comparison runs both sides through
 * `buildRemoteConnectionDaemonState`, the same normalizer that produced the
 * stored `daemon.baseUrl`, so it compares like with like rather than raw
 * strings that differ only by a trailing slash.
 *
 * A file that changed and no longer declares an endpoint at all cannot vouch
 * for anything: the caller then falls back to rule 2 (matching endpoints) or
 * reports the lease as unreleasable, which is a warning and an orphaned lease
 * — the correct price for not sending a credential somewhere it may not belong.
 */
function previousConfigStillSpeaksForPreviousEndpoint(
  previous: RemoteConnectionState,
  declaredDaemonBaseUrl: string | undefined,
): boolean {
  const declared = buildRemoteConnectionDaemonState({
    daemonBaseUrl: declaredDaemonBaseUrl,
  })?.baseUrl;
  return declared !== undefined && declared === previous.daemon?.baseUrl;
}

export async function releasePreviousLease(
  client: AgentDeviceClient,
  previous: RemoteConnectionState,
  options: {
    nextDaemonBaseUrl?: string;
    ambientDaemonAuthToken?: string;
    cwd: string;
    env: Record<string, string | undefined>;
  },
): Promise<PreviousLeaseReleaseNotice | undefined> {
  if (!previous.leaseId) return undefined;
  const auth = resolvePreviousLeaseAuth({
    previous,
    nextDaemonBaseUrl: options.nextDaemonBaseUrl,
    ambientDaemonAuthToken: options.ambientDaemonAuthToken,
    cwd: options.cwd,
    env: options.env,
  });
  if (!auth.canAuthenticate) {
    return buildUnreleasedPreviousLeaseNotice(
      previous,
      'no credential known to belong to that endpoint was available',
    );
  }
  try {
    await releaseRemoteConnectionLease(client, previous, auth.daemonAuthToken);
    return undefined;
  } catch {
    // Reconnect must still succeed; surface the failure instead of hiding it.
    return buildUnreleasedPreviousLeaseNotice(previous, 'the release request failed');
  }
}

function buildUnreleasedPreviousLeaseNotice(
  previous: RemoteConnectionState,
  reason: string,
): PreviousLeaseReleaseNotice {
  return {
    status: 'unreleased',
    message:
      `Could not release the previous lease ${previous.leaseId} ` +
      `(tenant ${previous.tenant}, run ${previous.runId}) ` +
      `at ${previous.daemon?.baseUrl ?? 'its daemon'}: ${reason}. ` +
      'It was left in place — release it manually if it is still active.',
  };
}

async function releaseAcquiredLeaseOnWriteFailure(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  lease: Lease | undefined,
): Promise<void> {
  if (!lease) return;
  try {
    await client.leases.release({
      tenant: state.tenant,
      runId: state.runId,
      leaseId: lease.leaseId,
      leaseBackend: state.leaseBackend ?? lease.backend,
      leaseProvider: state.leaseProvider ?? lease.leaseProvider,
      clientId: state.clientId ?? lease.clientId,
      deviceKey: state.deviceKey ?? lease.deviceKey,
    });
  } catch {
    // Preserve the state-write failure; cleanup is best-effort.
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
  if (!flags.daemonBaseUrl && connectionProviderRequiresRemoteDaemon(profile.leaseProvider)) {
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

async function allocateOrReuseLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  leaseBackend: LeaseBackend,
  policy: ConnectionLeasePolicy,
  flags: CliFlags,
): Promise<{ lease: Lease; acquired: boolean }> {
  if (state.leaseId && state.leaseBackend === leaseBackend) {
    const existing = await heartbeatOrAllocateLease(client, state.leaseId, {
      tenant: state.tenant,
      runId: state.runId,
      leaseBackend,
      leaseProvider: state.leaseProvider,
      clientId: state.clientId,
      deviceKey: state.deviceKey,
      ttlMs: policy.ttlMs(state),
    });
    if (existing) return { lease: existing, acquired: false };
  }
  const lease = await client.leases.allocate({
    tenant: state.tenant,
    runId: state.runId,
    leaseBackend,
    leaseProvider: state.leaseProvider,
    clientId: state.clientId,
    deviceKey: state.deviceKey,
    ttlMs: policy.ttlMs(state),
    platform: state.platform ?? flags.platform,
    target: state.target ?? flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    providerApp: flags.providerApp,
    providerOsVersion: flags.providerOsVersion,
    providerProject: flags.providerProject,
    providerBuild: flags.providerBuild,
    providerSessionName: flags.providerSessionName,
    ...readCloudDeviceFeatureProfileFields(flags),
    awsProjectArn: flags.awsProjectArn,
    awsDeviceArn: flags.awsDeviceArn,
    awsAppArn: flags.awsAppArn,
    awsRegion: flags.awsRegion,
    awsInteractionMode: flags.awsInteractionMode,
  });
  return { lease, acquired: true };
}

async function resolveProxyLeaseState(options: {
  command: string;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  flags: CliFlags;
  leaseBackend?: LeaseBackend;
}): Promise<{ state: RemoteConnectionState; device?: DeviceInfo }> {
  if (!proxyLeaseAllocatingCommands.has(options.command)) {
    if (options.state.leaseId && options.state.deviceKey) return { state: options.state };
    throw new AppError(
      'INVALID_ARGS',
      'No active proxy device lease for this session; run open first.',
    );
  }
  const device = await resolveSelectedDevice(options.client, options.flags);
  const deviceKey = buildProxyDeviceKey(device);
  return {
    state: {
      ...options.state,
      deviceKey,
      leaseBackend:
        options.state.leaseBackend ?? options.leaseBackend ?? leaseBackendForDevice(device),
      platform: options.state.platform ?? device.platform,
      target: options.state.target ?? device.target,
      updatedAt: new Date().toISOString(),
    },
    device,
  };
}

function applyResolvedDeviceSelector(flags: CliFlags, device: DeviceInfo): void {
  flags.platform = device.platform;
  flags.target = device.target ?? flags.target;
  if (isIosFamily(device)) {
    flags.udid = device.id;
    return;
  }
  if (device.platform === 'android') {
    flags.serial = device.id;
  }
}

async function resolveSelectedDevice(
  client: AgentDeviceClient,
  flags: CliFlags,
): Promise<DeviceInfo> {
  const devices = await client.devices.list({
    platform: flags.platform,
    target: flags.target,
    device: flags.device,
    udid: flags.udid,
    serial: flags.serial,
    iosSimulatorDeviceSet: flags.iosSimulatorDeviceSet,
    androidDeviceAllowlist: flags.androidDeviceAllowlist,
  });
  return await resolveDevice(
    devices.map((device) => ({
      ...deviceFieldsFromPublicPlatform(device.platform),
      id: device.id,
      name: device.name,
      kind: device.kind,
      target: device.target,
      booted: device.booted,
    })),
    {
      platform: flags.platform,
      target: flags.target,
      deviceName: flags.device,
      udid: flags.udid,
      serial: flags.serial,
    },
  );
}

function buildProxyDeviceKey(device: DeviceInfo): string {
  return `${publicPlatformString(device)}:${device.target ?? 'mobile'}:${device.id}`;
}

function leaseBackendForDevice(device: DeviceInfo): LeaseBackend | undefined {
  if (isIosFamily(device)) return 'ios-instance';
  if (device.platform === 'android') return 'android-instance';
  return undefined;
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
  scope: {
    tenant: string;
    runId: string;
    leaseBackend: LeaseBackend;
    leaseProvider?: RemoteConnectionState['leaseProvider'];
    clientId?: string;
    deviceKey?: string;
    ttlMs?: number;
  },
): Promise<Lease | undefined> {
  try {
    return await client.leases.heartbeat({
      tenant: scope.tenant,
      runId: scope.runId,
      leaseId,
      leaseBackend: scope.leaseBackend,
      leaseProvider: scope.leaseProvider,
      clientId: scope.clientId,
      deviceKey: scope.deviceKey,
      ttlMs: scope.ttlMs,
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
