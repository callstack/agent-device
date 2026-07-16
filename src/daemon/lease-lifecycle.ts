import { emitDiagnostic } from '../utils/diagnostics.ts';
import { leaseScopeToReleaseRequest } from '../core/lease-scope.ts';
import type { DeviceLease, LeaseRegistry } from './lease-registry.ts';
import { buildSessionLeaseFromRequest, type SessionLease } from './lease-context.ts';
import {
  assertRequestLeaseAdmission,
  assertRequestLeaseAdmissionPreflight,
} from './request-admission.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, SessionState } from './types.ts';
import type { LeaseLifecycleProvider } from './handlers/lease.ts';

export type ExpiredProviderLeaseRecovery = (lease: DeviceLease) => Promise<void>;

export type SessionTeardown = (session: SessionState, sessionName: string) => Promise<void>;

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

export function assertLockedLeaseAdmissionPreflight(req: DaemonRequest): void {
  assertRequestLeaseAdmissionPreflight(req);
}

export async function cleanupExpiredLeasedSession(params: {
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  teardownSession: SessionTeardown;
}): Promise<boolean> {
  const session = params.sessionStore.get(params.sessionName);
  const lease = session?.lease;
  if (!session || !lease) return false;
  const expiredLease = params.leaseRegistry.consumeExpiredLease(lease.leaseId);
  if (!expiredLease) return false;
  emitDiagnostic({
    level: 'info',
    phase: 'leased_session_expired',
    data: {
      reason: 'LEASE_EXPIRED',
      leaseId: lease.leaseId,
      session: session.name,
      deviceKey: lease.deviceKey,
    },
  });
  await params.teardownSession(session, session.name).catch((error) => {
    emitDiagnostic({
      level: 'debug',
      phase: 'leased_session_expiry_cleanup_failed',
      data: {
        reason: 'LEASE_EXPIRED',
        leaseId: lease.leaseId,
        session: session.name,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  });
  params.sessionStore.delete(session.name);
  return true;
}

export function admitRequestLeaseForLockedScope(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
}): DaemonRequest {
  const { sessionName, sessionStore, leaseRegistry } = params;
  const existingSession = sessionStore.get(sessionName);
  const activeLease = assertRequestLeaseAdmission(params.req, leaseRegistry, existingSession);
  if (!activeLease) return params.req;

  const nextReq = {
    ...params.req,
    internal: {
      ...params.req.internal,
      admittedLease: activeLease,
    },
  };
  if (existingSession?.lease) {
    sessionStore.set(sessionName, {
      ...existingSession,
      lease: {
        ...existingSession.lease,
        leaseBackend: activeLease.backend,
        expiresAt: activeLease.expiresAt,
      },
    });
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

export async function releaseSessionLease(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
  leaseLifecycleProvider?: LeaseLifecycleProvider;
}): Promise<Record<string, unknown> | undefined> {
  const lease = params.session.lease;
  if (!lease) return undefined;
  const releaseRequest = leaseScopeToReleaseRequest({
    leaseId: lease.leaseId,
    tenantId: lease.tenantId,
    runId: lease.runId,
    leaseBackend: lease.leaseBackend,
    leaseProvider: lease.leaseProvider,
    deviceKey: lease.deviceKey,
    clientId: lease.clientId,
  });
  const activeLease = params.leaseRegistry.getLease(releaseRequest);
  const providerData = activeLease
    ? await params.leaseLifecycleProvider?.release?.(activeLease)
    : undefined;
  const result = params.leaseRegistry.releaseLease(releaseRequest);
  emitDiagnostic({
    level: 'info',
    phase: 'session_lease_released',
    data: {
      session: params.session.name,
      leaseId: lease.leaseId,
      released: result.released,
    },
  });
  return providerData;
}
