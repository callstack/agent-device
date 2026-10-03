/**
 * The one rule that says which sessions belong to a tenant: under tenant
 * isolation every session name lives beneath its own `<tenant>:` prefix.
 *
 * It is written once because two sides depend on it agreeing — `scopeRequestSession`
 * (`request-admission.ts`) names the session, and the request diagnostics route
 * (`request-diagnostics-http.ts`, #1801) decides from the name alone whether a
 * caller may read that session's record long after the session itself is gone.
 *
 * The naming side has a precondition the reading side must honor: it applies the
 * prefix ONLY under tenant isolation, which the daemon forces exactly when the
 * auth hook ATTESTS the tenant (`http-server.ts`). A tenant the caller merely
 * declared — the `x-agent-device-tenant` header on a daemon with no auth hook —
 * never scopes anything, so its sessions keep the plain names the client asked
 * for (`default`, `cwd:<hash>:default`). Reading the prefix rule onto those names
 * made the record read stricter than the write that produced it, and refused a
 * caller its own record; `isTenantAddressableSessionName` is the rule with that
 * precondition attached, so the two sides cannot disagree again.
 */

/**
 * A caller's session namespace as the daemon actually partitions it.
 *
 * `partitioned` is the naming precondition, not a permission level: true means
 * `scopeRequestSession` has put every session this caller can reach beneath
 * `<tenant>:`, so a name outside that prefix cannot be the caller's own. False
 * means the tenant is an unattested label the daemon never partitioned by — the
 * same caller can already run any command in any session over `/rpc` — so the
 * prefix carries no ownership to check.
 */
export type TenantSessionNamespace = {
  tenant: string;
  partitioned: boolean;
};

export function tenantScopedSessionName(tenant: string, session: string): string {
  return isTenantOwnedSessionName(tenant, session) ? session : `${tenant}:${session}`;
}

export function isTenantOwnedSessionName(tenant: string, sessionName: string): boolean {
  return sessionName.startsWith(`${tenant}:`);
}

/**
 * Whether a caller in `namespace` may address `sessionName` by name — the read
 * counterpart of `scopeRequestSession`'s naming decision, and the only tenant
 * rule the diagnostics route applies.
 */
export function isTenantAddressableSessionName(
  namespace: TenantSessionNamespace,
  sessionName: string,
): boolean {
  if (!namespace.partitioned) return true;
  return isTenantOwnedSessionName(namespace.tenant, sessionName);
}
