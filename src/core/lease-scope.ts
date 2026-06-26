import type { LeaseBackend } from '../contracts.ts';
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

export type LeaseDiagnosticsContext = Omit<LeaseScope, 'leaseTtlMs'>;

export type LeaseRpcCommand = 'lease_allocate' | 'lease_heartbeat' | 'lease_release';

export type LeaseAllocateRequestScope = {
  tenantId: string;
  runId: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
};

export type LeaseScopedRequestScope = {
  leaseId: string;
  tenantId?: string;
  runId?: string;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  deviceKey?: string;
  clientId?: string;
  ttlMs?: number;
};

type LeaseRequestLike = {
  flags?: Record<string, unknown>;
  meta?: {
    tenantId?: string;
    runId?: string;
    leaseId?: string;
    leaseTtlMs?: number;
    leaseBackend?: LeaseBackend;
    leaseProvider?: string;
    deviceKey?: string;
    clientId?: string;
  };
};

type LeaseOptionsLike = {
  tenant?: string;
  runId?: string;
  leaseId?: string;
  leaseTtlMs?: number;
  ttlMs?: number;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
  provider?: string;
  deviceKey?: string;
  clientId?: string;
};

export function leaseScopeFromRequest(req: LeaseRequestLike): LeaseScope {
  return stripUndefined({
    tenantId: req.meta?.tenantId ?? readFlagString(req.flags, 'tenant'),
    runId: req.meta?.runId ?? readFlagString(req.flags, 'runId'),
    leaseId: req.meta?.leaseId ?? readFlagString(req.flags, 'leaseId'),
    leaseTtlMs: req.meta?.leaseTtlMs,
    leaseBackend: req.meta?.leaseBackend,
    leaseProvider:
      req.meta?.leaseProvider ??
      readFlagString(req.flags, 'leaseProvider') ??
      readFlagString(req.flags, 'provider'),
    deviceKey: req.meta?.deviceKey ?? readFlagString(req.flags, 'deviceKey'),
    clientId: req.meta?.clientId ?? readFlagString(req.flags, 'clientId'),
  });
}

export function leaseScopeFromOptions(options: LeaseOptionsLike): LeaseScope {
  return stripUndefined({
    tenantId: options.tenant,
    runId: options.runId,
    leaseId: options.leaseId,
    leaseTtlMs: options.leaseTtlMs ?? options.ttlMs,
    leaseBackend: options.leaseBackend,
    leaseProvider: options.leaseProvider ?? options.provider,
    deviceKey: options.deviceKey,
    clientId: options.clientId,
  });
}

export function leaseScopeToRequestMeta(scope: LeaseScope): LeaseRequestLike['meta'] {
  return stripUndefined({
    tenantId: scope.tenantId,
    runId: scope.runId,
    leaseId: scope.leaseId,
    leaseTtlMs: scope.leaseTtlMs,
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
  });
}

export function leaseScopeToCommandFlags(scope: LeaseScope): Record<string, unknown> {
  return stripUndefined({
    tenant: scope.tenantId,
    runId: scope.runId,
    leaseId: scope.leaseId,
    leaseBackend: scope.leaseBackend,
  });
}

export function leaseScopeToAllocateRequest(scope: LeaseScope): LeaseAllocateRequestScope {
  return stripUndefined({
    tenantId: scope.tenantId ?? '',
    runId: scope.runId ?? '',
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
    ttlMs: scope.leaseTtlMs,
  }) as LeaseAllocateRequestScope;
}

export function leaseScopeToHeartbeatRequest(scope: LeaseScope): LeaseScopedRequestScope {
  return leaseScopeToScopedRequest(scope);
}

export function leaseScopeToReleaseRequest(
  scope: LeaseScope,
): Omit<LeaseScopedRequestScope, 'ttlMs'> {
  const { ttlMs: _ttlMs, ...request } = leaseScopeToScopedRequest(scope);
  return request;
}

export function leaseScopeToLeaseRpcParams(
  scope: LeaseScope,
  command: LeaseRpcCommand,
  options: {
    includeTokenParam: boolean;
    token?: string;
    session?: string;
  },
): Record<string, unknown> {
  const common = stripUndefined({
    ...(options.includeTokenParam ? { token: options.token } : {}),
    session: options.session,
    tenantId: scope.tenantId,
    runId: scope.runId,
    leaseProvider: scope.leaseProvider,
    clientId: scope.clientId,
    deviceKey: scope.deviceKey,
  });
  switch (command) {
    case 'lease_allocate':
      return {
        ...common,
        ...stripUndefined({
          ttlMs: scope.leaseTtlMs,
          backend: scope.leaseBackend,
        }),
      };
    case 'lease_heartbeat':
      return {
        ...common,
        ...stripUndefined({
          leaseId: scope.leaseId,
          ttlMs: scope.leaseTtlMs,
        }),
      };
    case 'lease_release':
      return {
        ...common,
        ...stripUndefined({
          leaseId: scope.leaseId,
        }),
      };
  }
}

export function leaseScopeToConnectionMetadata(
  scope: LeaseScope,
): Pick<LeaseScope, 'leaseProvider' | 'deviceKey' | 'clientId'> | undefined {
  const connection = stripUndefined({
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
  });
  return Object.keys(connection).length > 0 ? connection : undefined;
}

export function buildLeaseDiagnosticsContext(
  leaseScope: LeaseScope | undefined,
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

export function isProxyLeaseScope(scope: LeaseScope): boolean {
  return scope.leaseProvider === PROXY_LEASE_PROVIDER;
}

export function findMissingProxyLeaseFields(scope: LeaseScope): string[] {
  if (!isProxyLeaseScope(scope)) return [];
  return REQUIRED_PROXY_LEASE_FIELDS.filter((field) => !scope[field]);
}

function leaseScopeToScopedRequest(scope: LeaseScope): LeaseScopedRequestScope {
  return stripUndefined({
    leaseId: scope.leaseId ?? '',
    tenantId: scope.tenantId,
    runId: scope.runId,
    leaseBackend: scope.leaseBackend,
    leaseProvider: scope.leaseProvider,
    deviceKey: scope.deviceKey,
    clientId: scope.clientId,
    ttlMs: scope.leaseTtlMs,
  }) as LeaseScopedRequestScope;
}

function readFlagString(
  flags: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = flags?.[key];
  return typeof value === 'string' ? value : undefined;
}
