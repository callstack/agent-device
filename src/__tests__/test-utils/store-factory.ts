import path from 'node:path';
import { SessionStore } from '../../daemon/session-store.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';
import type { SessionRef, SessionState } from '../../daemon/session-state.ts';

export function makeSessionStore(prefix = 'agent-device-test-'): SessionStore {
  const tempRoot = mkdtempForTestSync(prefix);
  return new SessionStore(path.join(tempRoot, 'sessions'));
}

export function makeStoredSessionRef(session: SessionState, address = session.name): SessionRef {
  return makeSessionStore().publish(address, session);
}

/** Publishes a fixture or reuses its current record. After an update, pass the rebuilt record. */
export function storeSessionForTest(
  store: SessionStore,
  session: SessionState,
  address = session.name,
): SessionRef {
  const ref = store.lookup(address);
  if (!ref) return store.publish(address, session);
  if (ref.session !== session) throw new Error('A different test session occupies this address');
  return ref;
}
