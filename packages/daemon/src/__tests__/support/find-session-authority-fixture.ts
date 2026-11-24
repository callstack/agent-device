import type { DaemonRequest } from '../../core/daemon-request.ts';
import type { SessionStore } from '../../core/session-store.ts';
import { SessionCoordinator } from '../../core/session-store.ts';
import type { FindSessionAuthority } from '../../core/interaction/internal/types.ts';

/**
 * The session authority the dispatcher hands a `find` route for its admitted lifetime, built from the
 * store a test published into. A test that calls the find route directly uses this rather than a
 * hand-rolled stand-in, so it exercises the same lifetime-bound operations the dispatcher constructs.
 * Returns `undefined` for an address with no session, which is what the route sees for one.
 */
export function bindFindSessionForTest(params: {
  sessionStore: SessionStore;
  sessionName: string;
  req: DaemonRequest;
}): FindSessionAuthority | undefined {
  const { sessionStore, sessionName, req } = params;
  const ref = sessionStore.lookup(sessionName);
  if (!ref) return undefined;
  return {
    captureRef: ref,
    mutations: new SessionCoordinator(sessionStore).mutate(req, ref, () => true),
  };
}
