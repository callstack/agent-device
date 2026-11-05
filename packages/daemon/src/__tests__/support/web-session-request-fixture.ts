import type { DaemonRequest } from '../../core/daemon-request.ts';
import { deriveWebSessionIdentity } from '../../core/session-tenant-scope.ts';
import { scopeRequestSession } from '../../sessions/request-admission.ts';

/**
 * A hand-built request with the one private fact the request scope always adds:
 * `internal.webSession`, derived the way `createRequestExecutionScope` derives it
 * (`request-execution-scope.ts`): tenant-scoped through `scopeRequestSession`, and kept as-is
 * when the request already carries one.
 *
 * Device resolution refuses a web device whose request carries no web session, so a test that
 * resolves a device without routing the request through the scope has to state that fact the way
 * the scope does. It seeds nothing else: remote-input restriction and command defaults stay the
 * scope's own work.
 */
export function seedWebSessionIdentity<Request extends DaemonRequest>(req: Request): Request {
  const tenantScopedReq = scopeRequestSession(req);
  return {
    ...req,
    internal: {
      ...req.internal,
      webSession:
        req.internal?.webSession ?? deriveWebSessionIdentity(req.session, tenantScopedReq),
    },
  };
}
