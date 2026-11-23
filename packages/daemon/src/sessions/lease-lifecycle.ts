import type { PluginInventoryEntry } from '@agent-device/contracts/plugin-inventory';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { clearDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import { leaseReleaseRequestFor } from '../resources/lease-registry-scope.ts';
import type {
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderAppCatalog,
} from '@agent-device/contracts/device';
import { assertRequestLeaseAdmission } from './request-admission.ts';
import type { SessionStore } from '../core/session-store.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';

export type SessionTeardown = (ref: SessionRef) => Promise<void>;

export type LeaseEndReason = 'LEASE_RELEASED' | 'LEASE_EXPIRED' | 'PROVIDER_INSTANCE_ENDED';

export async function releaseExpiredProviderLease(
  recoverExpiredLease: ((lease: DeviceLease) => Promise<void | boolean>) | undefined,
  lease: DeviceLease,
): Promise<boolean> {
  if (!lease.leaseProvider || !recoverExpiredLease) return false;

  try {
    if ((await recoverExpiredLease(lease)) === false) return false;
    emitDiagnostic({
      level: 'info',
      phase: 'provider_lease_expired_released',
      data: {
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      },
    });
    return true;
  } catch (error) {
    emitDiagnostic({
      level: 'error',
      phase: 'provider_lease_expiry_release_failed',
      data: {
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return false;
  }
}

export async function endLeasedSession(
  ref: SessionRef,
  sessionStore: SessionStore,
  teardownSession: SessionTeardown,
  env: HostEnvironment['env'],
): Promise<'claim-release-unconfirmed' | undefined> {
  const claim = ref.session.deviceClaim;
  await teardownSession(ref);
  const current = sessionStore.resolveCurrent(ref);
  if (!current || current.deviceClaim !== claim) return;
  try {
    if ((await clearDeviceClaim(claim, env)) === 'unattributable')
      return 'claim-release-unconfirmed';
  } catch {
    return 'claim-release-unconfirmed';
  }
  sessionStore.finalizeRepairTeardown(ref);
  sessionStore.retire(ref);
}

export function admitRequestLeaseForLockedScope(params: {
  env: HostEnvironment['env'];
  req: DaemonRequest;
  session: SessionState | undefined;
  leaseRegistry: LeaseRegistry;
  providerAppCatalog?: ProviderAppCatalog;
  pluginInventory?: readonly PluginInventoryEntry[];
  daemonPolicy?: DaemonPolicy;
}): DaemonRequest {
  const activeLease = assertRequestLeaseAdmission(
    params.req,
    params.leaseRegistry,
    params.session,
    {
      env: params.env,
      providerAppCatalog: params.providerAppCatalog,
      pluginInventory: params.pluginInventory,
      daemonPolicy: params.daemonPolicy,
    },
  );
  if (!activeLease) return params.req;
  return { ...params.req, internal: { ...params.req.internal, admittedLease: activeLease } };
}

function closeLeaseDecision(
  activeLease: DeviceLease | undefined,
  provider: LeaseLifecycleProvider | undefined,
  shutdownRequested = false,
): 'retained' | 'provider-release' | 'local-release' {
  if (activeLease?.retainOnClose && !shutdownRequested) return 'retained';
  return activeLease && provider?.release ? 'provider-release' : 'local-release';
}

export function beginSessionLeaseEnd(
  lease: SessionState['lease'],
  registry: LeaseRegistry,
  shutdownRequested: boolean,
): void {
  if (!lease) return;
  let current: DeviceLease | undefined;
  try {
    current = registry.inspectLeaseForClose(leaseReleaseRequestFor(lease));
  } catch {
    // The release step reports scope errors after local teardown.
    return;
  }
  if (!current || (current.retainOnClose && !shutdownRequested)) return;
  registry.beginLeaseEnd(current, {
    sessionsSettled: false,
    providerRelease: 'pending',
    requestRelease: 'close',
  });
}

export function inspectSessionLeaseRetainedOnClose(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
}): boolean {
  const { lease } = params.session;
  if (!lease) return false;
  return (
    closeLeaseDecision(
      params.leaseRegistry.inspectLeaseForClose(leaseReleaseRequestFor(lease)),
      undefined,
    ) === 'retained'
  );
}

export function inspectSessionProviderReleaseOnClose(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
  shutdownRequested?: boolean;
}): boolean {
  const { lease } = params.session;
  if (!lease) return false;
  return (
    closeLeaseDecision(
      params.leaseRegistry.inspectLeaseForClose(leaseReleaseRequestFor(lease)),
      params.leaseLifecycleProvider,
      params.shutdownRequested,
    ) === 'provider-release'
  );
}

/**
 * Releases the lease a closing session holds, unless its owner allocated it with `retainOnClose`.
 * `endedLeaseId` names the lease the close ended, including one that was already inactive.
 */
export async function releaseSessionLease(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
}): Promise<{ endedLeaseId?: string; providerData?: Record<string, unknown> }> {
  const lease = params.session.lease;
  if (!lease) return {};
  const releaseRequest = leaseReleaseRequestFor(lease);
  const activeLease = params.leaseRegistry.getLease(releaseRequest, true);
  const decision = closeLeaseDecision(activeLease, params.leaseLifecycleProvider);
  if (decision === 'retained') {
    emitDiagnostic({
      level: 'info',
      phase: 'session_lease_released',
      data: {
        session: params.session.name,
        leaseId: lease.leaseId,
        released: false,
        retained: true,
      },
    });
    return {};
  }
  const { releaseLease } = await import('../resources/lease-release.ts');
  if (!activeLease) return { endedLeaseId: lease.leaseId };
  const result = await releaseLease(
    params.leaseRegistry,
    decision === 'provider-release' ? params.leaseLifecycleProvider : undefined,
    activeLease,
    { sessionsSettled: false, requestRelease: 'close' },
  );
  if (result.release === 'unknown')
    throw result.error ?? params.leaseRegistry.leaseEndRefusal(lease.leaseId);
  const providerData = result.provider;
  emitDiagnostic({
    level: 'info',
    phase: 'session_lease_released',
    data: {
      session: params.session.name,
      leaseId: lease.leaseId,
      released: true,
    },
  });
  return { endedLeaseId: lease.leaseId, ...(providerData ? { providerData } : {}) };
}
