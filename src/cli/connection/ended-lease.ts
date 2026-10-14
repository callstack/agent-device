import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import { readEndedLeases } from '@agent-device/contracts/lease-scope';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '../../remote/remote-connection-state.ts';
import { isHostAllocatedLease } from '../commands/connection-runtime.ts';
import { connectionProviderCapabilities } from './provider-policy.ts';

/**
 * Forgets the stored proxy lease once a daemon reply says its request ended that lease, so the next
 * `open` allocates instead of heartbeating a lease that no longer exists.
 */
export function forgetEndedProxyLease(flags: CliFlags, response: DaemonResponse): void {
  if (!flags.remoteConfig) return;
  const endedLeaseIds = readEndedLeases(response).map((lease) => lease.leaseId);
  if (endedLeaseIds.length === 0) return;
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  const state = readRemoteConnectionState({ stateDir, session: flags.session ?? 'default' });
  if (!state?.leaseId || !endedLeaseIds.includes(state.leaseId)) return;
  if (isHostAllocatedLease(state)) return;
  if (connectionProviderCapabilities(state.leaseProvider).leaseKind !== 'proxy') return;
  writeRemoteConnectionState({
    stateDir,
    state: { ...state, leaseId: undefined, updatedAt: new Date().toISOString() },
  });
}
