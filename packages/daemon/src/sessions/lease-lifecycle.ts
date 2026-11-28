import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { LEASE_REASONS, leaseScopeToReleaseRequest } from '@agent-device/contracts/lease-scope';
import { clearDeviceClaim } from '@agent-device/daemon-contracts/device-claims';
import { resolveCommandDeviceClaimPolicy } from '@agent-device/command-registry/registry';
import { isLeaseAdmissionExempt } from '../core/daemon-command-registry.ts';
import type { LeaseRegistry } from '../resources/lease-registry.ts';
import type {
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderAppCatalog,
} from '@agent-device/contracts/device';
import {
  buildSessionLeaseFromRequest,
  isBoundedCompositeRequest,
  resolveLeaseScope,
  type SessionLease,
} from '../core/lease-context.ts';
import { assertRequestLeaseAdmission } from './request-admission.ts';
import { AppError, errorMessage } from '@agent-device/kernel/errors';
import { thrownBeforeDispatch } from '../execution/request-dispatch-disclosure.ts';
import type { SessionStore } from '../core/session-store.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import type { DaemonPolicy } from '@agent-device/daemon-contracts/daemon-policy-file';

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
 * Ends the session of the request whose session lease expired, or refuses the request before that
 * teardown. A composite is refused so it does not lose its session mid-run. A request that would do
 * device work and names a lease that is not live is refused so its client can reallocate and resend:
 * the refusal says `dispatched: no`, so nothing of the request may run first, and the lease expiry
 * sweep ends the session instead. A `close` or an admission-exempt command ends it now. For a
 * session whose lease the registry no longer holds, such a command queues the daemon's lease end,
 * and a `close` that holds the session also ends it at once.
 * Returns whether the request ended the session or queued its end.
 */
export async function cleanupExpiredLeasedSession(params: {
  req: DaemonRequest;
  env: HostEnvironment['env'];
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  teardownSession: SessionTeardown;
  /** Starts the daemon's lease end outside this request's execution locks. */
  queueLeaseEnd?: (leaseId: string) => Promise<void>;
  holdsSessionLocks: (ref: SessionRef) => boolean;
}): Promise<boolean> {
  const ref = params.sessionStore.lookup(params.sessionName);
  const lease = ref?.session.lease;
  if (!ref || !lease) return false;
  const expired = params.leaseRegistry.consumeExpiredLease(lease.leaseId, () => {
    if (!refusesExpiredLeaseTeardown(params.req, params.leaseRegistry)) return;
    throw new AppError('UNAUTHORIZED', 'Lease is not active', {
      reason: LEASE_REASONS.notFound.reason,
      dispatched: 'no',
    });
  });
  const end = async () =>
    await endLeasedSession(
      ref,
      params.sessionStore,
      params.teardownSession,
      'LEASE_EXPIRED',
      params.env,
    );
  if (expired) {
    await end();
    return true;
  }
  if (
    !params.queueLeaseEnd ||
    doesDeviceWork(params.req) ||
    isBoundedCompositeRequest(params.req) ||
    params.leaseRegistry.inspectLeaseBackend(lease.leaseId) !== undefined
  ) {
    return false;
  }
  // The lease end locks every session of the lease, so no request waits for it under its own locks.
  void params.queueLeaseEnd(lease.leaseId);
  if (endsSession(params.req) && params.holdsSessionLocks(ref)) await end();
  return true;
}

function refusesExpiredLeaseTeardown(req: DaemonRequest, leaseRegistry: LeaseRegistry): boolean {
  return (
    req.command === 'batch' ||
    req.command === 'replay' ||
    isBoundedCompositeRequest(req) ||
    (doesDeviceWork(req) && namesInactiveLease(req, leaseRegistry))
  );
}

/** Whether admission would refuse the lease the request names, which must then come first. */
function namesInactiveLease(req: DaemonRequest, leaseRegistry: LeaseRegistry): boolean {
  const { leaseId } = resolveLeaseScope(req);
  return leaseId !== undefined && leaseRegistry.inspectLeaseBackend(leaseId) === undefined;
}

function doesDeviceWork(req: DaemonRequest): boolean {
  return !endsSession(req) && !isLeaseAdmissionExempt(req.command);
}

/** A `close` ends its session, unless a replay step asks it to close only the app. */
function endsSession(req: DaemonRequest): boolean {
  return (
    resolveCommandDeviceClaimPolicy(req.command) === 'release-session' &&
    req.internal?.closeAppOnly !== true
  );
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
): Promise<void> {
  const session = ref.session;
  const leaseId = session.lease?.leaseId;
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

export function admitRequestLeaseForLockedScope(params: {
  env: HostEnvironment['env'];
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  providerAppCatalog?: ProviderAppCatalog;
  daemonPolicy?: DaemonPolicy;
  /** The request ended its session, or queued that end, just before admission. */
  sessionEnded?: boolean;
}): DaemonRequest {
  const { sessionName, sessionStore, leaseRegistry } = params;
  const ref = sessionStore.lookup(sessionName);
  const existingSession = ref?.session;
  // Admission runs before any handler, so its refusal says `dispatched: no`: a client that let
  // admission check its lease (`lease-admission`) reallocates and resends on that refusal alone.
  // After a teardown the refusal cannot claim that nothing ran.
  let activeLease: DeviceLease | undefined;
  try {
    activeLease = assertRequestLeaseAdmission(params.req, leaseRegistry, existingSession, {
      env: params.env,
      providerAppCatalog: params.providerAppCatalog,
      daemonPolicy: params.daemonPolicy,
    });
  } catch (error) {
    throw params.sessionEnded ? error : thrownBeforeDispatch(error);
  }
  if (!activeLease) return params.req;

  const nextReq = {
    ...params.req,
    internal: {
      ...params.req.internal,
      admittedLease: activeLease,
    },
  };
  if (ref && existingSession?.lease) {
    sessionStore.update(ref, (current) => ({
      lease: {
        ...current.lease!,
        leaseBackend: activeLease.backend,
        expiresAt: activeLease.expiresAt,
      },
    }));
  }
  return nextReq;
}

export function resolveSessionLeaseForRequest(params: {
  req: Pick<DaemonRequest, 'flags' | 'meta' | 'internal'>;
  existingLease?: SessionLease;
}): SessionLease | undefined {
  return (
    buildSessionLeaseFromRequest(params.req, params.req.internal?.admittedLease) ??
    params.existingLease
  );
}

function closeReleaseRequest(session: SessionState) {
  const lease = session.lease!;
  return leaseScopeToReleaseRequest({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.leaseBackend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
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
  if (!params.session.lease) return false;
  return (
    closeLeaseDecision(
      params.leaseRegistry.inspectLeaseForClose(closeReleaseRequest(params.session)),
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
  if (!params.session.lease) return false;
  return (
    closeLeaseDecision(
      params.leaseRegistry.inspectLeaseForClose(closeReleaseRequest(params.session)),
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
  const releaseRequest = closeReleaseRequest(params.session);
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
