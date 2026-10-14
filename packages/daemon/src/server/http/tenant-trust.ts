import { AppError, normalizeError } from '@agent-device/kernel/errors';

/**
 * `attested` separates the two ways a request can carry a trusted tenant, because
 * the daemon treats them differently everywhere downstream: an ATTESTED tenant
 * forces `sessionIsolation: 'tenant'`, so `scopeRequestSession` partitions the
 * caller's session namespace beneath `<tenant>:`. A merely DECLARED one (no auth
 * hook is configured, so the header is taken at face value) partitions nothing —
 * the same caller can already reach any session over `/rpc`.
 */
export type TenantTrustDecision =
  | { trusted: true; tenantId: string | undefined; attested: boolean }
  | { trusted: false };

export function resolveTrustedTenant(params: {
  hookConfigured: boolean;
  hookAttestedTenant: string | undefined;
  clientDeclaredTenant: string | undefined;
}): TenantTrustDecision {
  const { hookConfigured, hookAttestedTenant, clientDeclaredTenant } = params;
  if (hookAttestedTenant) return { trusted: true, tenantId: hookAttestedTenant, attested: true };
  if (!hookConfigured) {
    return { trusted: true, tenantId: clientDeclaredTenant, attested: false };
  }
  return { trusted: false };
}

export function tenantTrustRejectionError(): ReturnType<typeof normalizeError> {
  return normalizeError(
    new AppError('UNAUTHORIZED', 'Request tenant is not attested by the auth hook'),
  );
}
