import path from 'node:path';
import { safeSessionName } from '@agent-device/host-kit/session-paths';
import type { DurableCaptureSessionStore } from '../../durable-capture/index.ts';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';

export type CaptureAdmissionSessionStore<S> = DurableCaptureSessionStore<S> &
  Readonly<{
    get(name: string): S | undefined;
    sessionsDir: string;
  }>;

/**
 * The whole of the daemon `SessionStore` these admission modules ever address — `set`,
 * `resolveSessionDir`, and the read-back a test asserts on — over a fresh temp directory, so a
 * test of this family needs no session record, store class, or daemon import.
 */
export function makeCaptureAdmissionSessionStore<S>(
  prefix: string,
): CaptureAdmissionSessionStore<S> {
  const sessionsDir = mkdtempForTestSync(prefix);
  const sessions = new Map<string, S>();
  return {
    set: (name, session) => void sessions.set(name, session),
    get: (name) => sessions.get(name),
    resolveSessionDir: (name) => path.join(sessionsDir, safeSessionName(name)),
    sessionsDir,
  };
}
