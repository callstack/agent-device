import type { CommandFlags } from '../../core/dispatch.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, SessionState } from '../types.ts';

/**
 * Record a session action if a session is active. No-op when session is undefined.
 */
export function recordSessionAction(
  sessionStore: SessionStore,
  session: SessionState | undefined,
  req: DaemonRequest,
  command: string,
  result: Record<string, unknown> | undefined,
): void {
  if (!session) return;
  sessionStore.recordAction(session, {
    command,
    positionals: req.positionals ?? [],
    flags: (req.flags ?? {}) as CommandFlags,
    result: result ?? {},
  });
}
