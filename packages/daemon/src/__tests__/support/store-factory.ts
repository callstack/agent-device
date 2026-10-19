import path from 'node:path';
import { SessionStore } from '../../core/session-store.ts';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import type { SessionRef, SessionState } from '../../core/session-state.ts';

export function makeSessionStore(prefix = 'agent-device-test-'): SessionStore {
  const tempRoot = mkdtempForTestSync(prefix);
  return new SessionStore(path.join(tempRoot, 'sessions'), createLiveTestHostEnvironment());
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
