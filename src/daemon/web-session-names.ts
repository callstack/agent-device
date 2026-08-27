import type { SessionStore } from './session-store.ts';
import type { SessionState } from './types.ts';

export function isWebSession(session: SessionState): boolean {
  return session.device.platform === 'web';
}

export function openWebSessionNames(sessionStore: SessionStore): string[] {
  return sessionStore
    .toArray()
    .filter((session) => session.device.platform === 'web')
    .map((session) => session.name);
}
