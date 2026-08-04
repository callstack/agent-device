import path from 'node:path';
import { SessionStore } from '../../daemon/session-store.ts';
import { mkdtempForTestSync } from './tmp-dir.ts';

export function makeSessionStore(prefix = 'agent-device-test-'): SessionStore {
  const tempRoot = mkdtempForTestSync(prefix);
  return new SessionStore(path.join(tempRoot, 'sessions'));
}
