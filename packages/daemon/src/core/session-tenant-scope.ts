import { isTenantOwnedSessionName } from '@agent-device/contracts/daemon-http';
import { AppError } from '@agent-device/kernel/errors';
import type { WebSessionIdentity } from '@agent-device/kernel/device';
import type { SessionScope } from '@agent-device/contracts/session';
import type { DaemonRequest } from './daemon-request.ts';

/**
 * The one rule that says which sessions belong to a tenant: under tenant
 * isolation every session name lives beneath its own `<tenant>:` prefix
 * (`isTenantOwnedSessionName` in `@agent-device/contracts/daemon-http`).
 *
 * It is written once because several sides depend on it agreeing — `scopeRequestSession`
 * (`request-admission.ts`) names the session, and the request diagnostics route
 * (`request-diagnostics-http.ts`, #1801) and `@agent-device/proxy` decide from the
 * name alone whether a caller may read that session's record long after the session
 * itself is gone.
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

/** The tenant-relative name that addresses this session under tenant scoping. */
export function tenantPublicSessionName(tenant: string, session: string): string {
  return isTenantOwnedSessionName(tenant, session) ? session.slice(tenant.length + 1) : session;
}

/**
 * The web session a request runs in: the tenant-relative name as the caller supplied it, and the
 * tenant under tenant isolation, or the implicit workspace scope. A workspace identity has no name.
 * A web session device is derived from it alone, so a blank name reaches web validation instead of
 * becoming the default session's browser, and the store key's `<tenant>:` prefix never enters the
 * backend key. `supplied` is the name before `scopeRequestSession` rewrites a blank one to
 * `default`; `scoped` carries the attested tenant. Only the request scope calls this.
 */
export function deriveWebSessionIdentity(
  supplied: string,
  scoped: Pick<DaemonRequest, 'meta'>,
  scope: SessionScope,
): WebSessionIdentity {
  const tenantId = scoped.meta?.sessionIsolation === 'tenant' ? scoped.meta.tenantId : undefined;
  if (scope.kind === 'cwd') return { kind: 'workspace', id: scope.id };
  return tenantId === undefined
    ? { name: supplied }
    : {
        name: tenantPublicSessionName(tenantId, supplied),
        namespace: { kind: 'tenant', id: tenantId },
      };
}

/** The web session the request scope derived for this request. */
export function requestWebSession(req: DaemonRequest): WebSessionIdentity {
  const webSession = req.internal?.webSession;
  if (webSession === undefined) {
    throw new AppError('UNKNOWN', 'A request reached device resolution outside a request scope.', {
      reason: 'request_web_session_missing',
    });
  }
  return webSession;
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
