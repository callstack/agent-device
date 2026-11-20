import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import { readEndedLeases } from '@agent-device/contracts/lease-scope';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { connectionProviderCapabilities } from './provider-policy.ts';
import { isHostAllocatedLease } from '../commands/connection-lease-transaction.ts';

/**
 * Records on a connection whether its provider forgets an ended lease. Call it where the provider's
 * plugin is loaded: `connect` and connection materialization. `close` and `session` load no plugin,
 * so they read the recorded value.
 */
export function withEndedLeasePolicy(
  state: RemoteConnectionState,
  env: NodeJS.ProcessEnv,
): RemoteConnectionState {
  const forgetsEndedLease =
    connectionProviderCapabilities(state.leaseProvider, env).forgetsEndedConnectionLease === true;
  return state.forgetsEndedLease === forgetsEndedLease ? state : { ...state, forgetsEndedLease };
}

/**
 * Forgets the stored connection lease once a daemon reply says its request ended that lease, so the next
 * `open` allocates instead of heartbeating a lease that no longer exists.
 */
export function forgetEndedConnectionLease(
  flags: CliFlags,
  response: DaemonResponse,
  host: HostEnvironment,
): void {
  if (!flags.remoteConfig) return;
  const endedLeaseIds = readEndedLeases(response).map((lease) => lease.leaseId);
  if (endedLeaseIds.length === 0) return;
  const stateDir = resolveDaemonPaths(flags.stateDir, {
    cwd: host.cwd,
    env: host.env,
  }).baseDir;
  const state = readRemoteConnectionState({ stateDir, session: flags.session ?? 'default' });
  if (!state?.leaseId || !endedLeaseIds.includes(state.leaseId)) return;
  if (isHostAllocatedLease(state)) return;
  // The recorded declaration needs no plugin. A connection stored without one reads what this
  // process can answer without loading the plugin store.
  const forgetsEndedLease =
    state.forgetsEndedLease ??
    connectionProviderCapabilities(state.leaseProvider, host.env).forgetsEndedConnectionLease;
  if (!forgetsEndedLease) return;
  writeRemoteConnectionState({
    stateDir,
    state: { ...state, leaseId: undefined, updatedAt: new Date().toISOString() },
  });
}
