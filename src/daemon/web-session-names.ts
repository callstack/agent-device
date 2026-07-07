import type { SessionStore } from './session-store.ts';

export function openWebSessionNames(sessionStore: SessionStore): string[] {
  return sessionStore
    .toArray()
    .filter((session) => session.device.platform === 'web')
    .map((session) => session.name);
}
