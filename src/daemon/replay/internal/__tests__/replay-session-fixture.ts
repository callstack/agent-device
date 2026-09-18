import { createReplaySession } from '../../../handlers/session-replay-command.ts';
import type { SessionStore } from '../../../session-store.ts';

export function replaySessionForTest(sessionStore: SessionStore, sessionName: string) {
  return createReplaySession(sessionName, '', sessionStore);
}

export function replayCoordinatorForTest(sessionStore: SessionStore, sessionName: string) {
  return replaySessionForTest(sessionStore, sessionName).coordinator;
}

export function replayDivergenceForTest(sessionStore: SessionStore, sessionName: string) {
  const session = replaySessionForTest(sessionStore, sessionName);
  return {
    session: session.observationStore.get(),
    sessionName,
    sessionStore: session.store,
    observationStore: session.observationStore,
    resumeStamper: session.coordinator.resumeStamper,
  };
}
