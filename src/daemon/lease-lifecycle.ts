import { emitDiagnostic } from '../utils/diagnostics.ts';
import { leaseScopeToReleaseRequest } from '../core/lease-scope.ts';
import type { LeaseRegistry } from './lease-registry.ts';
import { buildSessionLeaseFromRequest, type SessionLease } from './lease-context.ts';
import {
  assertRequestLeaseAdmission,
  assertRequestLeaseAdmissionPreflight,
} from './request-admission.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, SessionState } from './types.ts';

export type SessionTeardown = (session: SessionState, sessionName: string) => Promise<void>;

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

export function releaseSessionLease(params: {
  session: SessionState;
  leaseRegistry: LeaseRegistry;
}): void {
  const lease = params.session.lease;
  if (!lease) return;
  const result = params.leaseRegistry.releaseLease(
    leaseScopeToReleaseRequest({
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.leaseBackend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
    }),
  );
  emitDiagnostic({
    level: 'info',
    phase: 'session_lease_released',
    data: {
      session: params.session.name,
      leaseId: lease.leaseId,
      released: result.released,
    },
  });
}
