import { webBackendKeyOf } from '@agent-device/kernel/device';
import type { SessionStore } from '../core/session-store.ts';
import type { SessionState } from '../core/session-state.ts';

export function isWebSession(session: SessionState): boolean {
  return session.device.platform === 'web';
}

/** The backend keys of the web sessions the store publishes. */
export function openWebSessionNames(sessionStore: SessionStore): string[] {
  return sessionStore.toArray().flatMap((session) => webBackendKeyOf(session.device.id) ?? []);
}
