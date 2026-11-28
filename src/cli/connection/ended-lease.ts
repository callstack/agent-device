import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { CliFlags } from '@agent-device/contracts/command';
import { readEndedLeases } from '@agent-device/contracts/lease-scope';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { tryWithConnectionLock } from './cloud-connection-record.ts';
import { declaredConnectionCapabilities } from './provider-policy.ts';
import { isHostAllocatedLease } from '../commands/connection-lease-transaction.ts';

export type ConnectionStateLocation = { stateDir: string; session: string };

/**
 * Forgets the stored connection lease once a daemon reply says its request ended that lease, so the next
 * `open` allocates instead of heartbeating a lease that no longer exists. A proxy connection keeps
 * the id as `endedLeaseId`: the daemon lists the output that it kept for an ended lease only to a
 * request that sends that lease's id.
 */
async function forgetLeaseAt(
  location: ConnectionStateLocation,
  response: DaemonResponse,
  host: HostEnvironment,
  cloudGeneration?: string,
): Promise<void> {
  const endedLeaseIds = readEndedLeases(response).map((lease) => lease.leaseId);
  if (endedLeaseIds.length === 0) return;
  const { stateDir } = location;
  await tryWithConnectionLock(location, () => {
    const state = readRemoteConnectionState(location);
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

/** The remote-config connection of a session: its lease is forgotten only when it names one. */
export async function forgetEndedConnectionLease(
  flags: CliFlags,
  response: DaemonResponse,
  host: HostEnvironment,
  cloudGeneration?: string,
): Promise<void> {
  if (!flags.remoteConfig) return;
  const location = {
    stateDir: resolveDaemonPaths(flags.stateDir, { cwd: host.cwd, env: host.env }).baseDir,
    session: flags.session ?? 'default',
  };
  await forgetLeaseAt(location, response, host, cloudGeneration);
}

/**
 * Applies a daemon reply's ended leases to the stored connection. A cloud session names its
 * location; a remote-config session derives it from its flags. Connect and disconnect own their
 * lease, so their replies change nothing here.
 */
export async function applyEndedLeaseReplies(options: {
  response: DaemonResponse;
  flags: CliFlags;
  host: HostEnvironment;
  command: string;
  cloudGeneration?: string;
  cloudLocation?: ConnectionStateLocation;
}): Promise<void> {
  const { response, flags, host, command, cloudGeneration, cloudLocation } = options;
  if (command === 'connect' || command === 'disconnect') return;
  if (cloudGeneration !== undefined && cloudLocation) {
    await forgetLeaseAt(cloudLocation, response, host, cloudGeneration);
    return;
  }
  await forgetEndedConnectionLease(flags, response, host, cloudGeneration);
}
