import { INTERNAL_COMMANDS, PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import type { HostedDaemonAttachmentIdentity } from '@agent-device/daemon-contracts/daemon-resolution';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../core/daemon-request.ts';
import { resolveSessionlessLeaseAdmissionExemption } from '../core/daemon-command-registry.ts';
import { tenantScopedSessionName } from '../core/session-tenant-scope.ts';
import {
  assertRequestPresentsLease,
  LEASE_ADMISSION_REASONS,
  resolveLeaseScope,
  type SessionLease,
} from '../core/lease-context.ts';

export type HostedAttachmentScope = HostedDaemonAttachmentIdentity & {
  lease: SessionLease & { tenantId: string };
  assertCurrent(): string;
};

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
    const scope = resolveLeaseScope(req);
    if (scope.leaseId === undefined && permitsNoLease(req)) {
      assertRequestPresentsLease({ ...req, meta: { ...req.meta, leaseId: lease.leaseId } }, lease);
    } else {
      assertRequestPresentsLease(req, lease);
      if (
        req.command === INTERNAL_COMMANDS.leaseAllocate &&
        (scope.tenantId !== lease.tenantId ||
          scope.runId !== lease.runId ||
          scope.leaseBackend !== lease.backend ||
          scope.leaseProvider !== lease.leaseProvider ||
          scope.clientId !== lease.clientId ||
          scope.deviceKey !== lease.deviceKey)
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
