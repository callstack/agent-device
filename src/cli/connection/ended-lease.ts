import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import { readEndedLeases } from '@agent-device/contracts/lease-scope';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { withConnectionLock } from './cloud-connection-record.ts';
import { declaredConnectionCapabilities } from './provider-policy.ts';
import { isHostAllocatedLease } from '../commands/connection-lease-transaction.ts';

/**
 * Forgets the stored connection lease once a daemon reply says its request ended that lease, so the next
 * `open` allocates instead of heartbeating a lease that no longer exists. A proxy connection keeps
 * the id as `endedLeaseId`: the daemon lists the output that it kept for an ended lease only to a
 * request that sends that lease's id.
 */
export async function forgetEndedConnectionLease(
  flags: CliFlags,
  response: DaemonResponse,
  host: HostEnvironment,
  cloudGeneration?: string,
): Promise<void> {
  if (!flags.remoteConfig) return;
  const endedLeaseIds = readEndedLeases(response).map((lease) => lease.leaseId);
  if (endedLeaseIds.length === 0) return;
  const stateDir = resolveDaemonPaths(flags.stateDir, {
    cwd: host.cwd,
    env: host.env,
  }).baseDir;
  const session = flags.session ?? 'default';
  await withConnectionLock(stateDir, session, async () => {
    const state = readRemoteConnectionState({ stateDir, session });
    if (state?.cloudSession?.generation !== cloudGeneration) return;
    if (!state?.leaseId || !endedLeaseIds.includes(state.leaseId)) return;
    if (isHostAllocatedLease(state)) return;
    // `close` and `session` load no plugin store, so this reads what answers without one: the
    // provider's loaded declaration, then the plugin catalog.
    const capabilities = declaredConnectionCapabilities(state.leaseProvider, host.env);
    if (!capabilities?.forgetsEndedConnectionLease) return;
    writeRemoteConnectionState({
      stateDir,
      state: {
        ...state,
        leaseId: undefined,
        ...(capabilities.leaseKind === 'proxy' ? { endedLeaseId: state.leaseId } : {}),
        updatedAt: new Date().toISOString(),
      },
    });
  });
}
