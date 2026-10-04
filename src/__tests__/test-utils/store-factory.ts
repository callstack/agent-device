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
