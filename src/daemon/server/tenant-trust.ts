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
  | { trusted: false; reason?: 'host-principal-with-auth-hook' };

/**
 * A Host principal is attested by the front-end that holds the daemon token, so it partitions the
 * session namespace exactly like a hook-attested tenant. With an auth hook configured the hook is
 * the only attestor, and a principal header is refused rather than silently ranked against it.
 */
export function resolveTrustedTenant(params: {
  hookConfigured: boolean;
  hookAttestedTenant: string | undefined;
  clientDeclaredTenant: string | undefined;
  hostPrincipal?: string;
}): TenantTrustDecision {
  const { hookConfigured, hookAttestedTenant, clientDeclaredTenant, hostPrincipal } = params;
  if (hostPrincipal) {
    return hookConfigured
      ? { trusted: false, reason: 'host-principal-with-auth-hook' }
      : { trusted: true, tenantId: hostPrincipal, attested: true };
  }
  if (hookAttestedTenant) return { trusted: true, tenantId: hookAttestedTenant, attested: true };
  if (!hookConfigured) {
    return { trusted: true, tenantId: clientDeclaredTenant, attested: false };
  }
  return { trusted: false };
}

export function tenantTrustRejectionError(
  decision: Extract<TenantTrustDecision, { trusted: false }>,
): ReturnType<typeof normalizeError> {
  if (decision.reason === 'host-principal-with-auth-hook') {
    return normalizeError(
      new AppError(
        'UNAUTHORIZED',
        'A Host principal is not accepted while an auth hook attests tenants',
        {
          reason: decision.reason,
          hint: 'Run the Host front-end against a daemon without AGENT_DEVICE_HTTP_AUTH_HOOK.',
        },
      ),
    );
  }
  return normalizeError(
    new AppError('UNAUTHORIZED', 'Request tenant is not attested by the auth hook'),
  );
}
