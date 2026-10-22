import type { DaemonRequest } from './daemon-request.ts';
import { getRequestExecutionDeadlineMs } from '@agent-device/host-kit/request';
import {
  AppError,
  BOUNDED_COMPOSITE_RESOURCE_UNSUPPORTED_REASON,
} from '@agent-device/kernel/errors';
import {
  projectStandaloneCommand,
  type StandalonePublicForm,
} from '@agent-device/command-registry/standalone-command';
import type { LeaseBackend } from '@agent-device/kernel/contracts';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { RunnerLogicalLeaseContext } from '@agent-device/contracts/runner-lease-context';
import { stripUndefined } from '@agent-device/kernel/record';
import {
  findMissingProxyLeaseFields,
  isProxyLeaseScope,
  leaseScopeFromRequest,
  type LeaseScope,
} from '@agent-device/contracts/lease-scope';

export { findMissingProxyLeaseFields, isProxyLeaseScope };
export type { LeaseScope };

export function refuseBoundedCompositeResourceOperation(
  req: DaemonRequest,
  shape: string,
  publicForm?: StandalonePublicForm | null,
): never {
  const projection = projectStandaloneCommand(req, publicForm);
  throw new AppError('UNSUPPORTED_OPERATION', `${shape} cannot run within a bounded composite`, {
    reason: BOUNDED_COMPOSITE_RESOURCE_UNSUPPORTED_REASON,
    shape,
    ...projection,
    hint: projection.standaloneCommand
      ? `Run ${projection.standaloneCommand} separately with the same private CLI context.`
      : 'Run this operation separately with its original arguments and options and the same --session value, using the same private CLI context.',
    dispatched: 'no',
  });
}

export function isBoundedCompositeRequest(req: DaemonRequest): boolean {
  return getRequestExecutionDeadlineMs(req.meta?.requestId) !== undefined;
}

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
