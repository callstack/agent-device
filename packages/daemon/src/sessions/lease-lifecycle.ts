import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { throwIfRequestCanceled } from '@agent-device/host-kit/request';
import { LEASE_REASONS, leaseScopeToHeartbeatRequest } from '@agent-device/contracts/lease-scope';
import { clearDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import { leaseReleaseRequestFor } from '../resources/lease-registry-scope.ts';
import { assertMacOsAppLeaseProcess } from '../resources/macos-app-lease.ts';
import type { DeviceLease, LeaseLifecycleProvider } from '@agent-device/contracts/device';
import { resolveLeaseScope } from '../core/lease-context.ts';
import {
  assertRequestLeaseAdmission,
  resolveRequestSessionRef,
  type RequestLeaseAdmissionContext,
  type ResolveRequestSessionRef,
} from './request-admission.ts';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import type { SessionStore } from '../core/session-store.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';

export type ExpiredProviderLeaseRecovery = (lease: DeviceLease) => Promise<void>;

export type SessionTeardown = (ref: SessionRef) => Promise<void>;

export type LeaseEndReason = 'LEASE_RELEASED' | 'LEASE_EXPIRED' | 'PROVIDER_INSTANCE_ENDED';

export async function releaseExpiredProviderLease(
  recoverExpiredLease: ExpiredProviderLeaseRecovery | undefined,
  lease: DeviceLease,
): Promise<boolean> {
  if (!lease.leaseProvider || !recoverExpiredLease) return false;

  try {
    await recoverExpiredLease(lease);
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

/**
 * How a request treats a session whose lease expired. A request that holds the session lock ends
 * it (`inline`). A composite refuses the expired lease rather than tear its session down mid-run.
 * A request without the session lock leaves the session to the lease-end owner and its locks.
 */
export type ExpiredSessionTeardown = 'inline' | 'refuse' | 'lease-end-owner';

export async function cleanupExpiredLeasedSession(params: {
  env: HostEnvironment['env'];
  /** The session the request holds the lease of; a request that holds none ends no session. */
  ref: SessionRef | undefined;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  teardownSession: SessionTeardown;
  teardown: ExpiredSessionTeardown;
}): Promise<boolean> {
  const { ref } = params;
  const lease = ref?.session.lease;
  if (!ref || !lease) return false;
  if (
    !params.leaseRegistry.consumeExpiredLease(lease.leaseId, () => {
      if (params.teardown !== 'refuse') return;
      throw new AppError('UNAUTHORIZED', 'Lease is not active', {
        reason: LEASE_REASONS.notFound.reason,
        dispatched: 'no',
      });
    }) ||
    params.teardown !== 'inline'
  )
    return false;
  await endLeasedSession(
    ref,
    params.sessionStore,
    params.teardownSession,
    'LEASE_EXPIRED',
    params.env,
  );
  return true;
}

/**
 * Ends one session whose lease is gone (released or expired). The device claim is cleared even when
 * teardown fails: the lease that paid for the device has ended, so nobody may keep it.
 */
export async function endLeasedSession(
  ref: SessionRef,
  sessionStore: SessionStore,
  teardownSession: SessionTeardown,
  reason: LeaseEndReason,
  env: HostEnvironment['env'],
  /** Only the daemon log names the lease id. A request record can reach another client. */
  daemonScope = false,
): Promise<void> {
  const session = ref.session;
  const leaseId = daemonScope ? session.lease?.leaseId : undefined;
  emitDiagnostic({
    level: 'info',
    phase: 'leased_session_ended',
    data: { reason, leaseId, session: session.name, deviceKey: session.lease?.deviceKey },
  });
  await teardownSession(ref).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'leased_session_end_cleanup_failed',
      data: { reason, leaseId, session: session.name, error: errorMessage(error) },
    });
  });
  await clearDeviceClaim(session.deviceClaim, env).catch((error) => {
    emitDiagnostic({
      level: 'warn',
      phase: 'leased_session_end_device_claim_clear_failed',
      data: {
        session: session.name,
        deviceKey: session.deviceClaim?.deviceKey,
        error: errorMessage(error),
      },
    });
  });
  sessionStore.finalizeRepairTeardown(ref);
  sessionStore.retire(ref);
}

type LockedSessionParams = {
  env: HostEnvironment['env'];
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  teardown: ExpiredSessionTeardown;
  holdDeviceLock: (deviceId: string) => Promise<void>;
  teardownSession: SessionTeardown;
  admission: RequestLeaseAdmissionContext;
  onSuccessorAdmitted(lease: DeviceLease): void;
  resolveSessionRef?: ResolveRequestSessionRef;
};

/**
 * The session that a request acts through, resolved under the session lock. A request that
 * presents another active lease first ends a session whose lease is over, and then finds none.
 */
export async function resolveLockedRequestSessionRef(
  params: LockedSessionParams,
): Promise<SessionRef | undefined> {
  const { req, sessionName, sessionStore, resolveSessionRef = resolveRequestSessionRef } = params;
  const ref = sessionStore.lookup(sessionName);
  const ended =
    ref !== undefined &&
    params.teardown === 'inline' &&
    (await endExpiredSessionForSuccessor(params, ref));
  return resolveSessionRef(req, ended ? sessionStore.lookup(sessionName) : ref);
}

/**
 * Ends the session of a lease that is over, for a request that presents another active lease. A
 * new owner can then open the address before the lease sweep runs. Any other request ends nothing.
 */
async function endExpiredSessionForSuccessor(
  params: LockedSessionParams,
  ref: SessionRef,
): Promise<boolean> {
  const { leaseRegistry } = params;
  const expiredLeaseId = ref.session.lease?.leaseId;
  const successorScope = resolveLeaseScope(params.req);
  const successorLeaseId = successorScope.leaseId;
  if (!expiredLeaseId || !successorLeaseId || successorLeaseId === expiredLeaseId) return false;
  const canEndSession = () =>
    params.sessionStore.resolveCurrent(ref)?.lease?.leaseId === expiredLeaseId &&
    !leaseRegistry.inspectActiveLease(expiredLeaseId) &&
    leaseRegistry.inspectActiveLease(successorLeaseId) !== undefined;
  if (!canEndSession()) return false;
  await params.holdDeviceLock(ref.session.device.id);
  throwIfRequestCanceled(params.req.meta?.requestId);
  const admitSuccessor = () =>
    assertRequestLeaseAdmission(params.req, leaseRegistry, undefined, {
      ...params.admission,
      env: params.env,
      inspectOnly: true,
    });
  if (!canEndSession()) return false;
  const successor = admitSuccessor();
  if (!successor) return false;
  if (successor.backend === 'macos-app') {
    await assertMacOsAppLeaseProcess(successor);
    throwIfRequestCanceled(params.req.meta?.requestId);
    if (!canEndSession() || !admitSuccessor()) return false;
  }
  const admittedSuccessor = leaseRegistry.renewInspectedLeaseAdmission(
    leaseScopeToHeartbeatRequest(successorScope),
  );
  params.onSuccessorAdmitted(admittedSuccessor);
  await endLeasedSession(
    ref,
    params.sessionStore,
    params.teardownSession,
    'LEASE_EXPIRED',
    params.env,
  );
  // An inactive lease never becomes active again. The registry notes the expiry only now, so the
  // lease-end owner that it starts finds no session to end a second time.
  leaseRegistry.consumeExpiredLease(expiredLeaseId);
  return true;
}

export function admitRequestLeaseForLockedScope(params: {
  env: HostEnvironment['env'];
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  admission?: RequestLeaseAdmissionContext;
  resolveSessionRef?: ResolveRequestSessionRef;
}): DaemonRequest {
  const {
    sessionName,
    sessionStore,
    leaseRegistry,
    resolveSessionRef = resolveRequestSessionRef,
  } = params;
  // The addressed session still decides the app-lease veto.
  const addressed = sessionStore.lookup(sessionName);
  resolveSessionRef(params.req, addressed);
  const activeLease = assertRequestLeaseAdmission(params.req, leaseRegistry, addressed?.session, {
    env: params.env,
    ...params.admission,
  });
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
  const activeLease = params.leaseRegistry.getLease(releaseRequest);
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
  const result = await releaseLease(
    params.leaseRegistry,
    decision === 'provider-release' ? params.leaseLifecycleProvider : undefined,
    activeLease,
    releaseRequest,
  );
  const providerData = result.provider;
  emitDiagnostic({
    level: 'info',
    phase: 'session_lease_released',
    data: {
      session: params.session.name,
      leaseId: lease.leaseId,
      released: result.registryReleased,
    },
  });
  return { endedLeaseId: lease.leaseId, ...(providerData ? { providerData } : {}) };
}
