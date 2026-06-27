import type { CommandFlags } from '../../core/dispatch.ts';
import { SessionStore } from '../session-store.ts';
import type { DaemonRequest, SessionState } from '../types.ts';

/**
 * Record a session action if a session is active. No-op when session is undefined.
 *
 * By default the recorded positionals/flags mirror the request; pass `overrides` to
 * record a different set (e.g. resolved positionals or stripped public flags).
 */
export function recordSessionAction(
  sessionStore: SessionStore,
  session: SessionState | undefined,
  req: DaemonRequest,
  command: string,
  result: Record<string, unknown> | undefined,
  overrides?: { positionals?: string[]; flags?: CommandFlags },
): void {
  if (!session) return;
  sessionStore.recordAction(session, {
    command,
    positionals: overrides?.positionals ?? req.positionals ?? [],
    flags: overrides?.flags ?? ((req.flags ?? {}) as CommandFlags),
    result: result ?? {},
  });
}
