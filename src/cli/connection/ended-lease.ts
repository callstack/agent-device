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
import {
  declaredConnectionCapabilities,
  providerForgetsEndedConnectionLease,
} from './provider-policy.ts';
import { isHostAllocatedLease } from '../commands/connection-lease-transaction.ts';

/**
 * Records on a connection whether its provider forgets an ended lease. Call it where the provider's
 * plugin is loaded: `connect` and connection materialization. `close` and `session` load no plugin,
 * so they read the recorded value. A recorded value is the authority and is not computed again. A
 * provider whose plugin is not loaded declares nothing, so nothing is recorded for it.
 */
export function withEndedLeasePolicy(
  state: RemoteConnectionState,
  env: NodeJS.ProcessEnv,
): RemoteConnectionState {
  if (state.forgetsEndedLease !== undefined) return state;
  const declared = declaredConnectionCapabilities(state.leaseProvider, env);
  if (!declared) return state;
  return { ...state, forgetsEndedLease: declared.forgetsEndedConnectionLease === true };
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
  // The recorded policy is the authority. A connection stored without one reads what this process
  // answers without loading the plugin store.
  const forgetsEndedLease =
    state.forgetsEndedLease ?? providerForgetsEndedConnectionLease(state.leaseProvider, host.env);
  if (!forgetsEndedLease) return;
  writeRemoteConnectionState({
    stateDir,
    state: { ...state, leaseId: undefined, updatedAt: new Date().toISOString() },
  });
}
