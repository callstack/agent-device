/**
 * The one rule that says which sessions belong to a tenant: under tenant
 * isolation every session name lives beneath its own `<tenant>:` prefix.
 *
 * It is written once because two sides depend on it agreeing — `scopeRequestSession`
 * (`request-admission.ts`) names the session, and the request diagnostics route
 * (`request-diagnostics-http.ts`, #1801) decides from the name alone whether a
 * caller may read that session's record long after the session itself is gone.
 */

export function tenantScopedSessionName(tenant: string, session: string): string {
  return isTenantOwnedSessionName(tenant, session) ? session : `${tenant}:${session}`;
}

export function isTenantOwnedSessionName(tenant: string, sessionName: string): boolean {
  return sessionName.startsWith(`${tenant}:`);
}
