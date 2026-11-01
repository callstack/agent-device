import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
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
import { AppError, asAppError, errorMessage } from '@agent-device/kernel/errors';
import { leaseBackendForPlatform, type LeaseBackend } from '@agent-device/kernel/contracts';
import type { Lease } from '@agent-device/contracts/client';
import type { CliFlags } from '@agent-device/contracts/command';
import type { CloudProviderSessionResult } from '@agent-device/contracts/observability';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import { connectionProviderCapabilities } from '../connection/provider-policy.ts';
import {
  connectionLeasePolicyForState,
  type ConnectionLeasePolicy,
} from './connection-lease-policy.ts';
import { bindLeaseNamedDevice } from './proxy-lease-device.ts';

type LeaseRelease = () => Promise<{ released: boolean }>;

const LEASE_ROLLBACK_RELEASE_FAILED_REASON = 'LEASE_RELEASE_FAILED';

/** One newly created lease awaits release or transfer to a durable session record. */
export type LeaseLedger = {
  /** Release or transfer the previous lease before tracking another allocation. */
  track(leaseId: string, release: LeaseRelease): void;
  /** A resolved release ends ownership, including when the daemon reports no such lease. */
  end(leaseId: string): Promise<{ released: boolean }>;
  transfer(leaseId: string | undefined): void;
  releaseOwnedOnFailure(failure: unknown): Promise<unknown>;
};

export function createLeaseLedger(): LeaseLedger {
  let owned: { leaseId: string; release: LeaseRelease } | undefined;

  async function end(leaseId: string): Promise<{ released: boolean }> {
    if (owned?.leaseId !== leaseId) return { released: false };
    const outcome = await owned.release();
    owned = undefined;
    return outcome;
  }

  return {
    track(leaseId, release) {
      owned = { leaseId, release };
    },
    end,
    transfer(leaseId) {
      if (owned?.leaseId === leaseId) owned = undefined;
    },
    async releaseOwnedOnFailure(failure) {
      if (!owned) return failure;
      const { leaseId } = owned;
      try {
        await end(leaseId);
        return failure;
      } catch (error) {
        const primary = asAppError(failure, 'COMMAND_FAILED');
        primary.details = {
          ...primary.details,
          leaseRollback: {
            leaseId,
            released: false,
            reason: LEASE_ROLLBACK_RELEASE_FAILED_REASON,
            error: errorMessage(error),
          },
        };
        return primary;
      }
    },
  };
}

/**
 * Brings the connection's lease up to date for this command: renews the one the record names or
 * allocates the one it does not, then settles the platform axis that decides which device that lease
 * rents. A lease this command created enters `leaseLedger` the moment the provider grants it, before
 * any validation or binding here can fail, so the caller's failure path still sees it.
 */
export async function acquireConnectionLease(options: {
  command: string;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  nextFlags: CliFlags;
  positionals?: string[];
  leaseLedger: LeaseLedger;
}): Promise<{ state: RemoteConnectionState; changed: boolean }> {
  const { command, client, state, nextFlags, leaseLedger } = options;
  const deferredAppSelection = connectionProviderCapabilities(
    state.leaseProvider,
  ).supportsDeferredAppSelection;
  const initialApp =
    deferredAppSelection && command === PUBLIC_COMMANDS.open ? options.positionals?.[0] : undefined;
  if (deferredAppSelection) delete nextFlags.providerApp;
  const leasePolicy = connectionLeasePolicyForState(state);
  let nextState = state;
  let changed = false;
  if (leasePolicy.shouldAllocate(command)) {
    const materialized = await materializeLeaseForCommand({
      command,
      client,
      state,
      nextState,
      nextFlags,
      initialApp,
      policy: leasePolicy,
      leaseLedger,
    });
    nextState = materialized.state;
    changed = materialized.changed;
  }
  nextState = {
    ...nextState,
    platform: carriedConnectionPlatform(state.session, nextState, nextFlags),
  };
  nextFlags.platform = nextState.platform;
  return { state: nextState, changed };
}

/**
 * Settles the platform axis: a command that reached no allocator still returns flags and a record on
 * this axis, and the record can carry an alias the request asked to narrow. Same rule as the binding
 * path inside the allocator, so a connection whose backend rents one leaf cannot serve another leaf
 * simply because this command never allocated.
 */
function carriedConnectionPlatform(
  session: string,
  state: RemoteConnectionState,
  flags: CliFlags,
): CliFlags['platform'] {
  const platform = narrowConnectionPlatform({
    leaseBackend: state.leaseBackend,
    recordedPlatform: state.platform,
    requestedPlatform: flags.platform,
  });
  if (!platform.ok) {
    throw connectionPlatformConflict({
      session,
      leaseBackend: state.leaseBackend,
      boundPlatform: platform.boundPlatform,
      requestedPlatform: platform.requestedPlatform,
      detail: 'bound-connection',
    });
  }
  return platform.platform;
}

async function materializeLeaseForCommand(options: {
  command: string;
  client: AgentDeviceClient;
  state: RemoteConnectionState;
  nextState: RemoteConnectionState;
  nextFlags: CliFlags;
  initialApp?: string;
  policy: ConnectionLeasePolicy;
  leaseLedger: LeaseLedger;
}): Promise<{ state: RemoteConnectionState; changed: boolean }> {
  const { command, client, state, nextFlags, policy, leaseLedger } = options;
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
  const platform = carriedConnectionPlatform(
    state.session,
    { ...nextState, leaseBackend },
    nextFlags,
  );
  assertRequestedConnectionTarget(state, nextFlags);
  nextState = { ...nextState, platform };
  nextFlags.platform = platform;
  let materializedLease = await allocateOrReuseLease(
    client,
    nextState,
    leaseBackend,
    policy,
    nextFlags,
    options.initialApp,
    resolvedLeaseState.allocateBySpec,
    leaseLedger,
  );
  if (resolvedLeaseState.allocateBySpec) {
    const bound = await bindLeaseNamedDevice({
      client,
      state: nextState,
      flags: nextFlags,
      leaseBackend,
      materialized: materializedLease,
      leaseLedger,
      allocateByDeviceKey: (boundState, flags) =>
        allocateOrReuseLease(
          client,
          boundState,
          leaseBackend,
          policy,
          flags,
          options.initialApp,
          undefined,
          leaseLedger,
        ),
    });
    nextState = bound.state;
    materializedLease = bound.materialized;
  }
  const lease = materializedLease.lease;
  nextFlags.leaseId = lease.leaseId;
  nextFlags.leaseBackend = leaseBackend;
  nextFlags.target = nextState.target ?? nextFlags.target;
  if (leaseStateMatches(nextState, lease, leaseBackend)) {
    return { state: nextState, changed: false };
  }
  return {
    state: buildMaterializedLeaseState(nextState, lease, leaseBackend, nextFlags),
    changed: true,
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

/**
 * The release that ends a lease this command allocated, scoped exactly as the allocation was: the
 * ledger holds it from the moment the provider grants the lease, so any later cleanup — this
 * command's failure path or a binding that refuses the lease — ends the same lease the same way.
 */
function leaseAllocationRelease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  leaseBackend: LeaseBackend,
  lease: Lease,
): LeaseRelease {
  return async () =>
    await client.leases.release({
      tenant: state.tenant,
      runId: state.runId,
      leaseId: lease.leaseId,
      leaseBackend,
      ...mergeRemoteConnectionRequestMetadata(lease, state),
      ...(lease.deviceKey !== undefined ? { deviceKey: lease.deviceKey } : {}),
    });
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

/**
 * A renewed lease is the record's own; only an allocation can bring a new one into this command, and
 * only when the daemon says this request created it. A run's repeat allocation gets the run's
 * existing lease back — the same answer the record-less caller of another run could get — and that
 * lease belongs to whoever holds it, never to this transaction.
 */
async function allocateOrReuseLease(
  client: AgentDeviceClient,
  state: RemoteConnectionState,
  leaseBackend: LeaseBackend,
  policy: ConnectionLeasePolicy,
  flags: CliFlags,
  initialApp: string | undefined,
  allocateBySpec: boolean | undefined,
  leaseLedger: LeaseLedger,
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
  const created = lease.created === true;
  if (created) {
    // Ownership starts here, before any caller of this function can fail on this lease.
    leaseLedger.track(lease.leaseId, leaseAllocationRelease(client, state, leaseBackend, lease));
  }
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
