import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { HostedDaemonAttachmentIdentity } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { resolveSessionlessLeaseAdmissionExemption } from '../core/daemon-command-registry.ts';
import { tenantScopedSessionName } from '../core/session-tenant-scope.ts';
import {
  assertRequestPresentsLease,
  LEASE_ADMISSION_REASONS,
  LEASE_FIELD_NORMALIZERS,
  resolveLeaseScope,
  type SessionLease,
} from '../core/lease-context.ts';

export type HostedAttachmentScope = HostedDaemonAttachmentIdentity & {
  lease: SessionLease & { tenantId: string };
  assertCurrent(): string;
};

export type HostedAuxiliaryAdmission = (request: {
  session?: string;
  tenantId?: string;
  leaseId: unknown;
}) => { tenantId: string; sessionNamespace: { tenant: string; partitioned: true } };

export function hostedAuxiliaryAdmission({
  session,
  lease: attachmentLease,
  assertCurrent,
}: HostedAttachmentScope): HostedAuxiliaryAdmission {
  const tenant = attachmentLease.tenantId;
  const address = tenantScopedSessionName(tenant, session);
  return ({ session: requestedSession, tenantId, leaseId }) => {
    const lease = { ...attachmentLease, leaseId: assertCurrent() };
    if (requestedSession !== undefined && requestedSession !== address) refuseScope();
    if (typeof leaseId !== 'string') refuseScope();
    assertRequestPresentsLease({ meta: { leaseId, tenantId } }, lease);
    return { tenantId: tenant, sessionNamespace: { tenant, partitioned: true } };
  };
}

export function hostedAttachmentAdmission({
  session,
  lease: attachmentLease,
  assertCurrent,
}: HostedAttachmentScope) {
  const address = tenantScopedSessionName(attachmentLease.tenantId, session);
  return (req: DaemonRequest): DaemonRequest => {
    const lease = { ...attachmentLease, leaseId: assertCurrent() };
    if ((req.session !== session && req.session !== address) || req.internal?.sessionOmitted)
      refuseScope();
    assertRequestPresentsLease(
      req,
      lease,
      permitsNoLease(req) ? { allowOmittedId: true } : undefined,
    );
    if (req.command === INTERNAL_COMMANDS.leaseAllocate) {
      const scope = resolveLeaseScope(req);
      const normalize = LEASE_FIELD_NORMALIZERS;
      if (
        normalize.tenantId(scope.tenantId) !== lease.tenantId ||
        normalize.runId(scope.runId) !== lease.runId ||
        normalize.leaseBackend(scope.leaseBackend) !== lease.backend ||
        normalize.leaseProvider(scope.leaseProvider) !== lease.leaseProvider ||
        normalize.clientId(scope.clientId) !== lease.clientId ||
        normalize.deviceKey(scope.deviceKey) !== lease.deviceKey
      )
        refuseScope();
    }
    return { ...req, meta: { ...req.meta, tenantId: lease.tenantId, sessionIsolation: 'tenant' } };
  };
}

function permitsNoLease(req: DaemonRequest): boolean {
  if (req.command === PUBLIC_COMMANDS.artifacts || req.command === INTERNAL_COMMANDS.sessionList)
    return true;
  const exemption = resolveSessionlessLeaseAdmissionExemption(req)?.kind;
  return exemption === 'provider-app-catalog' || exemption === 'unconditional';
}

function refuseScope(): never {
  throw new AppError('UNAUTHORIZED', 'Request does not match the hosted attachment scope.', {
    reason: LEASE_ADMISSION_REASONS.sessionMismatch.reason,
  });
}
