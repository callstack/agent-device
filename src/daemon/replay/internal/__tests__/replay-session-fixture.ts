import { createReplaySession } from '../../../handlers/session-replay-command.ts';
import { createReplayCoordinator } from '../../../session-replay-coordinator.ts';
import type { SessionStore } from '../../../session-store.ts';

export function replaySessionForTest(sessionStore: SessionStore, sessionName: string) {
  return createReplaySession(sessionName, '', sessionStore);
}

export function replayCoordinatorForTest(sessionStore: SessionStore, sessionName: string) {
  const session = replaySessionForTest(sessionStore, sessionName);
  return createReplayCoordinator({
    sessionStore: session.store,
    mutationStore: session.mutationStore,
  });
}

export function replayDivergenceForTest(sessionStore: SessionStore, sessionName: string) {
  const session = replaySessionForTest(sessionStore, sessionName);
  const coordinator = createReplayCoordinator({
    sessionStore: session.store,
    mutationStore: session.mutationStore,
  });
  return {
    session: session.observationStore.get(),
    sessionName,
    sessionStore: session.store,
    observationStore: session.observationStore,
    resumeStamper: coordinator.resumeStamper,
  };
}
