import type { DaemonRequest } from './types.ts';
import type { LeaseBackend } from '../kernel/contracts.ts';
import type { DeviceLease } from './lease-registry.ts';
import type { RunnerLogicalLeaseContext } from '../core/runner-lease-context.ts';
import { stripUndefined } from '../utils/parsing.ts';
import {
  DEFAULT_PROXY_LEASE_TTL_MS,
  buildLeaseDiagnosticsContext,
  findMissingProxyLeaseFields,
  isProxyLeaseScope,
  leaseScopeFromRequest,
  type LeaseDiagnosticsContext,
  type LeaseScope,
} from '../core/lease-scope.ts';

export {
  DEFAULT_PROXY_LEASE_TTL_MS,
  buildLeaseDiagnosticsContext,
  findMissingProxyLeaseFields,
  isProxyLeaseScope,
};
export type { LeaseDiagnosticsContext, LeaseScope };

export type SessionLease = {
  tenantId: string;
  runId: string;
  leaseId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  expiresAt?: number;
};

type SessionLeaseSource = {
  lease?: SessionLease | null;
  deviceLease?: SessionLease | null;
};

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return leaseScopeFromRequest(req);
}

export function buildSessionLeaseFromRequest(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  activeLease?: DeviceLease,
): SessionLease | undefined {
  const leaseScope = resolveLeaseScope(req);
  const leaseId = leaseScope.leaseId ?? activeLease?.leaseId;
  const tenantId = leaseScope.tenantId ?? activeLease?.tenantId;
  const runId = leaseScope.runId ?? activeLease?.runId;
  if (!tenantId || !runId || !leaseId) {
    return undefined;
  }
  return stripUndefined({
    tenantId,
    runId,
    leaseId,
    leaseBackend: leaseScope.leaseBackend ?? activeLease?.backend,
    leaseProvider: leaseScope.leaseProvider ?? activeLease?.leaseProvider,
    deviceKey: leaseScope.deviceKey ?? activeLease?.deviceKey,
    clientId: leaseScope.clientId ?? activeLease?.clientId,
    expiresAt: activeLease?.expiresAt,
  });
}

export function resolveRequestOrSessionLeaseScope(
  req: Pick<DaemonRequest, 'flags' | 'meta'>,
  session?: SessionLeaseSource | null,
): LeaseScope {
  const requestScope = resolveLeaseScope(req);
  const sessionLease = session?.lease ?? session?.deviceLease ?? undefined;
  return stripUndefined({
    tenantId: requestScope.tenantId ?? sessionLease?.tenantId,
    runId: requestScope.runId ?? sessionLease?.runId,
    leaseId: requestScope.leaseId ?? sessionLease?.leaseId,
    leaseTtlMs: requestScope.leaseTtlMs,
    leaseBackend: requestScope.leaseBackend ?? sessionLease?.leaseBackend,
    leaseProvider: requestScope.leaseProvider ?? sessionLease?.leaseProvider,
    deviceKey: requestScope.deviceKey ?? sessionLease?.deviceKey,
    clientId: requestScope.clientId ?? sessionLease?.clientId,
  });
}

export function resolveRunnerLogicalLeaseContext(
  req: Pick<DaemonRequest, 'meta'>,
): RunnerLogicalLeaseContext | undefined {
  const meta = req.meta as (DaemonRequest['meta'] & Record<string, unknown>) | undefined;
  const context = stripUndefined({
    leaseId: readNonEmptyString(meta?.leaseId),
    clientId: readNonEmptyString(meta?.clientId),
    tenantId: readNonEmptyString(meta?.tenantId),
    runId: readNonEmptyString(meta?.runId),
    leaseProvider: readNonEmptyString(meta?.leaseProvider),
    deviceKey: readNonEmptyString(meta?.deviceKey),
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
