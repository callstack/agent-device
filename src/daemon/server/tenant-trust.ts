import { AppError, normalizeError } from '@agent-device/kernel/errors';

export type TenantTrustDecision =
  | { trusted: true; tenantId: string | undefined }
  | { trusted: false };

export function resolveTrustedTenant(params: {
  hookConfigured: boolean;
  hookAttestedTenant: string | undefined;
  clientDeclaredTenant: string | undefined;
}): TenantTrustDecision {
  const { hookConfigured, hookAttestedTenant, clientDeclaredTenant } = params;
  if (hookAttestedTenant) return { trusted: true, tenantId: hookAttestedTenant };
  if (!hookConfigured) return { trusted: true, tenantId: clientDeclaredTenant };
  return { trusted: false };
}

export function tenantTrustRejectionError(): ReturnType<typeof normalizeError> {
  return normalizeError(
    new AppError('UNAUTHORIZED', 'Request tenant is not attested by the auth hook'),
  );
}
