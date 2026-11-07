import crypto from 'node:crypto';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { REMOTE_LEASE_IDLE_TTL_MS } from '@agent-device/contracts/lease-scope';
import { AppError } from '@agent-device/kernel/errors';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import type { AgentDeviceClient } from '@agent-device/command-surface';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';
import { connectionProviderCapabilities } from '../connection/provider-policy.ts';
import { resolveProxyLeaseState, type ResolvedLeaseState } from './proxy-lease-device.ts';

const leaseDeferredCommands = new Set([
  'artifacts',
  'connect',
  'connection',
  'close',
  'disconnect',
  'metro',
  'session',
  'shutdown',
]);
function remoteLeaseTtlMs(state: RemoteConnectionState): number | undefined {
  const capabilities = connectionProviderCapabilities(state.leaseProvider);
  return capabilities.leaseKind === 'proxy' ||
    capabilities.usesCloudWebDriverLease ||
    capabilities.holdsCloudDevice === true
    ? REMOTE_LEASE_IDLE_TTL_MS
    : undefined;
}

export type ConnectionLeasePolicy = {
  shouldAllocate(command: string): boolean;
  ttlMs(state: RemoteConnectionState): number | undefined;
  /** The id this client names a new lease with; without it the daemon mints one. */
  newLeaseId?(): string;
  resolveLeaseState(options: {
    command: string;
    client: AgentDeviceClient;
    state: RemoteConnectionState;
    flags: CliFlags;
    leaseBackend?: LeaseBackend;
  }): Promise<ResolvedLeaseState>;
};

export function connectionLeasePolicyForState(state: RemoteConnectionState): ConnectionLeasePolicy {
  if (state.leaseBackend === 'macos-app') return MACOS_APP_CONNECTION_LEASE_POLICY;
  const capabilities = connectionProviderCapabilities(state.leaseProvider);
  if (capabilities.leaseKind === 'proxy') {
    return PROXY_CONNECTION_LEASE_POLICY;
  }
  if (capabilities.supportsDeferredAppSelection) {
    return DEFERRED_APP_SELECTION_CONNECTION_LEASE_POLICY;
  }
  return DEFAULT_CONNECTION_LEASE_POLICY;
}

const DEFERRED_APP_SELECTION_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) =>
    command !== PUBLIC_COMMANDS.apps && !leaseDeferredCommands.has(command),
  ttlMs: remoteLeaseTtlMs,
  resolveLeaseState: async (options) => ({ state: options.state }),
};

const DEFAULT_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) => !leaseDeferredCommands.has(command),
  ttlMs: remoteLeaseTtlMs,
  resolveLeaseState: async (options) => ({ state: options.state }),
};

const PROXY_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) => command !== 'devices' && !leaseDeferredCommands.has(command),
  ttlMs: remoteLeaseTtlMs,
  // Known before the daemon allocates, so a host in front of it can name the lease with the same id.
  newLeaseId: () => crypto.randomBytes(16).toString('hex'),
  resolveLeaseState: resolveProxyLeaseState,
};

/**
 * A `macos-app` lease names one app, and the host allocated it: the client uses the lease its
 * remote config names as it is, and never resolves a device into a new key or allocates a lease.
 */
const MACOS_APP_CONNECTION_LEASE_POLICY: ConnectionLeasePolicy = {
  shouldAllocate: (command) => command !== 'devices' && !leaseDeferredCommands.has(command),
  ttlMs: () => undefined,
  resolveLeaseState: async ({ state }) => {
    if (!state.leaseId || !state.deviceKey) {
      throw new AppError(
        'INVALID_ARGS',
        'A macos-app connection needs the leaseId and deviceKey the host allocated in its remote config.',
      );
    }
    return { state: { ...state, platform: 'macos' } };
  },
};
