import type { DaemonRequest } from './types.ts';
import type { LeaseBackend } from '../contracts.ts';
import type { DeviceLease } from './lease-registry.ts';
import type { RunnerLogicalLeaseContext } from '../core/runner-lease-context.ts';
import { stripUndefined } from '../utils/parsing.ts';

const PROXY_LEASE_PROVIDER = 'proxy';
export const DEFAULT_PROXY_LEASE_TTL_MS = 300_000;
const REQUIRED_PROXY_LEASE_FIELDS = [
  'leaseId',
  'tenantId',
  'runId',
  'clientId',
  'deviceKey',
] as const satisfies readonly (keyof LeaseScope)[];

export type LeaseScope = {
  tenantId?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
};

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

export type LeaseDiagnosticsContext = Omit<LeaseScope, 'leaseTtlMs'>;

type SessionLeaseSource = {
  lease?: SessionLease | null;
  deviceLease?: SessionLease | null;
};

export function resolveLeaseScope(req: Pick<DaemonRequest, 'flags' | 'meta'>): LeaseScope {
  return {
    tenantId: req.meta?.tenantId ?? req.flags?.tenant,
    runId: req.meta?.runId ?? req.flags?.runId,
    leaseId: req.meta?.leaseId ?? req.flags?.leaseId,
    leaseTtlMs: req.meta?.leaseTtlMs,
    leaseBackend: req.meta?.leaseBackend,
    leaseProvider:
      req.meta?.leaseProvider ??
      readFlagString(req.flags, 'leaseProvider') ??
      readFlagString(req.flags, 'provider'),
    deviceKey: req.meta?.deviceKey ?? readFlagString(req.flags, 'deviceKey'),
    clientId: req.meta?.clientId ?? readFlagString(req.flags, 'clientId'),
  };
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

export function buildLeaseDiagnosticsContext(
  leaseScope: LeaseScope | SessionLease | undefined,
): LeaseDiagnosticsContext | undefined {
  if (!leaseScope) return undefined;
  const context = stripUndefined({
    tenantId: leaseScope.tenantId,
    runId: leaseScope.runId,
    leaseId: leaseScope.leaseId,
    leaseBackend: leaseScope.leaseBackend,
    leaseProvider: leaseScope.leaseProvider,
    deviceKey: leaseScope.deviceKey,
    clientId: leaseScope.clientId,
  });
  return Object.keys(context).length > 0 ? context : undefined;
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
    leaseProvider:
      readNonEmptyString(meta?.leaseProvider) ?? readNonEmptyString(meta?.leaseBackend),
    deviceKey: readNonEmptyString(meta?.deviceKey),
  });
  return Object.keys(context).length > 0 ? context : undefined;
}

export function isProxyLeaseScope(scope: LeaseScope | SessionLease): boolean {
  return scope.leaseProvider === PROXY_LEASE_PROVIDER;
}

export function findMissingProxyLeaseFields(scope: LeaseScope): string[] {
  if (!isProxyLeaseScope(scope)) return [];
  return REQUIRED_PROXY_LEASE_FIELDS.filter((field) => !scope[field]);
}

function readFlagString(flags: object | undefined, key: string): string | undefined {
  const value = (flags as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
