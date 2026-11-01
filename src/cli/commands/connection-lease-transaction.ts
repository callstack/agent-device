import {
  isInactiveLeaseError,
  readLeaseAllocateProviderFlags,
  requireLeaseDeviceSpec,
} from '@agent-device/contracts/lease-scope';
import {
  buildRemoteConnectionRequestMetadata,
  mergeRemoteConnectionRequestMetadata,
  narrowConnectionPlatform,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { AppError } from '@agent-device/kernel/errors';
import { leaseBackendForPlatform, type LeaseBackend } from '@agent-device/kernel/contracts';
import type { Lease } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import type { CloudProviderSessionResult } from '@agent-device/contracts/observability';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import type { ConnectionLeasePolicy } from './connection-lease-policy.ts';
import { bindLeaseNamedDevice } from './proxy-lease-device.ts';

export async function materializeLeaseForCommand(options: {
  command: string;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  nextState: RemoteConnectionState;
  nextFlags: CliFlags;
  initialApp?: string;
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
  const leaseBackend =
    nextState.leaseBackend ??
    preliminaryLeaseBackend ??
    requireRequestedLeaseBackend(nextFlags, command);
  assertRequestedConnectionBackend(state, leaseBackend);
  // One decision for one axis. Whichever of the backend, the record, and the request names the
  // narrowest platform, that is what this command records, sends, allocates, and returns; two that
  // cannot name the same device are refused here rather than resolved later by whoever read first.
  const platform = narrowConnectionPlatform({
    leaseBackend,
    recordedPlatform: nextState.platform,
    requestedPlatform: nextFlags.platform,
  });
  if (!platform.ok) {
    throw connectionPlatformConflict({
      session: state.session,
      leaseBackend,
      boundPlatform: platform.boundPlatform,
      requestedPlatform: platform.requestedPlatform,
      detail: 'bound-connection',
    });
  }
  // Read after the platform is settled: a request that asks for another Apple leaf also asks for a
  // different target, and the platform is the reason it is being refused.
  assertRequestedConnectionTarget(state, nextFlags);
  nextState = { ...nextState, platform: platform.platform };
  nextFlags.platform = platform.platform;
  let materializedLease = await allocateOrReuseLease(
    client,
    nextState,
    leaseBackend,
    policy,
    nextFlags,
    options.initialApp,
    resolvedLeaseState.allocateBySpec,
  );
  if (resolvedLeaseState.allocateBySpec) {
    const bound = await bindLeaseNamedDevice({
      client,
      state: nextState,
      flags: nextFlags,
      leaseBackend,
      materialized: materializedLease,
      allocateByDeviceKey: (boundState, flags) =>
        allocateOrReuseLease(client, boundState, leaseBackend, policy, flags, options.initialApp),
    });
    nextState = bound.state;
    materializedLease = bound.materialized;
  }
  const lease = materializedLease.lease;
  nextFlags.leaseId = lease.leaseId;
  nextFlags.leaseBackend = leaseBackend;
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
  const connection = mergeRemoteConnectionRequestMetadata(lease, state);
  return {
    ...state,
    leaseId: lease.leaseId,
    leaseBackend,
    ...connection,
    platform: state.platform ?? flags.platform,
    target: state.target ?? flags.target,
    updatedAt: new Date().toISOString(),
  };
}

/** The host allocated a `macos-app` lease and ends it itself; a tenant never releases it. */
export function isHostAllocatedLease(state: RemoteConnectionState): boolean {
  return state.leaseBackend === 'macos-app';
}

export async function releaseRemoteConnectionLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  // The daemon bearer token is never persisted on `state` (ADR 0007); callers
  // pass the token already resolved via the flag/env/CLI-session chain.
  daemonAuthToken?: string,
): Promise<{ released: boolean; provider?: CloudProviderSessionResult }> {
  if (!state.leaseId || isHostAllocatedLease(state)) return { released: false };
  const result = await client.leases.release({
    tenant: state.tenant,
    runId: state.runId,
    leaseId: state.leaseId,
    leaseBackend: state.leaseBackend,
    daemonBaseUrl: state.daemon?.baseUrl,
    daemonAuthToken,
    daemonTransport: state.daemon?.transport,
    daemonServerMode: state.daemon?.serverMode,
    ...buildRemoteConnectionRequestMetadata(state),
  });
  return result;
}

export async function releaseAcquiredLeaseOnWriteFailure(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  lease: Lease | undefined,
): Promise<void> {
  if (!lease) return;
  try {
    const connection = mergeRemoteConnectionRequestMetadata(state, lease);
    await client.leases.release({
      tenant: state.tenant,
      runId: state.runId,
      leaseId: lease.leaseId,
      leaseBackend: state.leaseBackend ?? lease.backend,
      ...connection,
    });
  } catch {
    // Preserve the state-write failure; cleanup is best-effort.
  }
}

export function resolveRequestedLeaseBackend(flags: CliFlags): LeaseBackend | undefined {
  return flags.leaseBackend ?? leaseBackendForPlatform(flags.platform);
}

function requireRequestedLeaseBackend(flags: CliFlags, command: string): LeaseBackend {
  const leaseBackend = resolveRequestedLeaseBackend(flags);
  if (leaseBackend) return leaseBackend;
  throw new AppError(
    'INVALID_ARGS',
    `${command} requires --platform ios|android|harmonyos or --lease-backend when the remote connection has not resolved a lease yet.`,
  );
}

async function allocateOrReuseLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  leaseBackend: LeaseBackend,
  policy: ConnectionLeasePolicy,
  flags: CliFlags,
  initialApp?: string,
  allocateBySpec?: boolean,
): Promise<{ lease: Lease; acquired: boolean }> {
  const connection = buildRemoteConnectionRequestMetadata(state);
  if (state.leaseId && state.leaseBackend === leaseBackend) {
    const existing = await heartbeatOrAllocateLease(client, state.leaseId, {
      tenant: state.tenant,
      runId: state.runId,
      leaseBackend,
      ...connection,
      ttlMs: policy.ttlMs(state),
    });
    if (existing) return { lease: existing, acquired: false };
  }
  if (leaseBackend === 'macos-app') {
    throw new AppError('UNAUTHORIZED', 'The host-allocated macos-app lease is no longer active.', {
      reason: 'LEASE_NOT_FOUND',
      leaseId: state.leaseId,
      hint: 'Ask the host for a new macos-app lease and update the remote config.',
    });
  }
  // The spec rides only a by-spec allocate, so it is added below rather than taken from the flags.
  const {
    osVersion: _osVersion,
    imageTag: _imageTag,
    physical: _physical,
    ...providerFlags
  } = readLeaseAllocateProviderFlags(flags);
  const lease = await client.leases.allocate({
    tenant: state.tenant,
    runId: state.runId,
    leaseId: policy.newLeaseId?.(),
    leaseBackend,
    ...connection,
    ...(allocateBySpec ? { deviceKey: undefined } : {}),
    ttlMs: policy.ttlMs(state),
    ...providerFlags,
    platform: state.platform ?? flags.platform,
    target: state.target ?? flags.target,
    ...(allocateBySpec ? requireLeaseDeviceSpec(flags).spec : {}),
    providerApp: initialApp ?? flags.providerApp,
  });
  return { lease, acquired: true };
}

/**
 * The refusal raised when the platform axis cannot be decided: two of the backend, the record, and
 * the request name devices that are not the same device. `detail` says which of the three disagreed,
 * because the advice differs — a bound connection is replaced with `--force`, and a request that
 * contradicts itself has no `--force` to reach.
 */
export function connectionPlatformConflict(
  options: Readonly<{
    session: string;
    leaseBackend: LeaseBackend | undefined;
    boundPlatform?: CliFlags['platform'];
    requestedPlatform?: CliFlags['platform'];
    detail: 'bound-connection' | 'requested-backend';
  }>,
): AppError {
  return new AppError(
    'INVALID_ARGS',
    options.detail === 'bound-connection'
      ? 'Active remote connection is already bound to a different platform. Re-run connect --force to replace it.'
      : 'The requested platform does not match the device this lease backend rents.',
    {
      session: options.session,
      leaseBackend: options.leaseBackend,
      platform: options.boundPlatform,
      requestedPlatform: options.requestedPlatform,
      reason: 'CONNECTION_PLATFORM_CONFLICT',
    },
  );
}

function assertRequestedConnectionBackend(
  state: RemoteConnectionState,
  requestedLeaseBackend: LeaseBackend,
): void {
  if (state.leaseBackend && state.leaseBackend !== requestedLeaseBackend) {
    throw new AppError(
      'INVALID_ARGS',
      'Active remote connection is already bound to a different lease backend. Re-run connect --force to replace it.',
      { session: state.session, leaseBackend: state.leaseBackend },
    );
  }
}

function assertRequestedConnectionTarget(state: RemoteConnectionState, flags: CliFlags): void {
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
      ...scope,
      leaseId,
    });
  } catch (error) {
    if (isInactiveLeaseError(error)) return undefined;
    throw error;
  }
}
