import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { asOptionalRecord } from '@agent-device/kernel/record';
import type { CliFlags } from '@agent-device/contracts/command';
import { readSessionCloseLeaseOutcome } from '@agent-device/contracts/lease-scope';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '../../remote/remote-connection-state.ts';
import { isHostAllocatedLease } from '../commands/connection-runtime.ts';
import { connectionProviderCapabilities } from './provider-policy.ts';

/**
 * Forgets the stored proxy lease once a daemon reply says a session close released it, so the next
 * `open` allocates instead of heartbeating a lease that no longer exists.
 */
export function forgetProxyLeaseReleasedByClose(flags: CliFlags, response: DaemonResponse): void {
  if (!flags.remoteConfig) return;
  const releasedLeaseIds = closeLeaseFields(response).flatMap((field) => {
    const lease = readSessionCloseLeaseOutcome(field);
    return lease?.outcome === 'released' ? [lease.leaseId] : [];
  });
  if (releasedLeaseIds.length === 0) return;
  const stateDir = resolveDaemonPaths(flags.stateDir).baseDir;
  const state = readRemoteConnectionState({ stateDir, session: flags.session ?? 'default' });
  if (!state?.leaseId || !releasedLeaseIds.includes(state.leaseId)) return;
  if (isHostAllocatedLease(state)) return;
  if (connectionProviderCapabilities(state.leaseProvider).leaseKind !== 'proxy') return;
  writeRemoteConnectionState({
    stateDir,
    state: { ...state, leaseId: undefined, updatedAt: new Date().toISOString() },
  });
}

/**
 * A close reports its lease on the reply, or in the error details when it failed after the release.
 * A batch carries each close step's reply in `results`, or in `partialResults` when a later step
 * failed; a batch that failed at the close step carries that step's error details.
 */
function closeLeaseFields(response: DaemonResponse): unknown[] {
  const body = response.ok ? response.data : response.error.details;
  const steps = response.ok ? body?.results : body?.partialResults;
  const stepBodies = Array.isArray(steps) ? steps.map((step) => asOptionalRecord(step)?.data) : [];
  return [body, ...stepBodies].map((stepBody) => asOptionalRecord(stepBody)?.lease);
}
