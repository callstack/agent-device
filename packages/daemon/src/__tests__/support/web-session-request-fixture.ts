import type { DaemonRequest } from '../../core/daemon-request.ts';
import { deriveWebSessionIdentity } from '../../core/session-tenant-scope.ts';

/**
 * A hand-built request with the one private fact the request scope always adds:
 * `internal.webSession`, derived by the same `deriveWebSessionIdentity` call
 * `createRequestExecutionScope` makes for every real request (`request-execution-scope.ts`).
 *
 * Device resolution refuses a web device whose request carries no web session, so a test that
 * resolves a device without routing the request through the scope has to state that fact the way
 * the scope does. It seeds nothing else: remote-input restriction, tenant naming and command
 * defaults stay the scope's own work.
 */
export function seedWebSessionIdentity<Request extends DaemonRequest>(req: Request): Request {
  return {
    ...req,
    internal: { ...req.internal, webSession: deriveWebSessionIdentity(req.session, req) },
  };
}
