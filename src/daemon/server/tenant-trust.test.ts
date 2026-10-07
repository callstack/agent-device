import { test } from 'vitest';
import assert from 'node:assert/strict';
import { resolveTrustedTenant, tenantTrustRejectionError } from './tenant-trust.ts';

test('a Host principal is an attested tenant that outranks the tenant a client declares', () => {
  assert.deepEqual(
    resolveTrustedTenant({
      hookConfigured: false,
      hookAttestedTenant: undefined,
      clientDeclaredTenant: 'someone-else',
      hostPrincipal: 'host-svc-3f9c2a1b',
    }),
    { trusted: true, tenantId: 'host-svc-3f9c2a1b', attested: true },
  );
});

test('a Host principal is refused with a typed reason while an auth hook attests tenants', () => {
  const decision = resolveTrustedTenant({
    hookConfigured: true,
    hookAttestedTenant: 'hook-tenant',
    clientDeclaredTenant: undefined,
    hostPrincipal: 'host-svc-3f9c2a1b',
  });

  assert.equal(decision.trusted, false);
  if (decision.trusted) return;
  const error = tenantTrustRejectionError(decision);
  assert.equal(error.code, 'UNAUTHORIZED');
  assert.equal(error.details?.reason, 'host-principal-with-auth-hook');
});
