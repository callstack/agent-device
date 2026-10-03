import path from 'node:path';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';
import { makeCaptureFixtureStore } from '../../durable-capture/session-binding.fixtures.ts';

export type CaptureAdmissionSessionStore<S> = ReturnType<
  typeof makeCaptureAdmissionSessionStore<S>
>;

export function makeCaptureAdmissionSessionStore<S>(prefix: string) {
  const sessionsDir = mkdtempForTestSync(prefix);
  return Object.freeze({
    ...makeCaptureFixtureStore<S>((name) => path.join(sessionsDir, safeSessionName(name))),
    sessionsDir,
  });
}
