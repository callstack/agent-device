import type { SessionState } from './types.ts';
import { isWebSession } from './web-session-names.ts';

export const DAEMON_SESSION_TEARDOWN_TIMEOUT_MS = 5_000;
export const SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS = 11_000;
export const WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS = 30_000;

/** Resolves the cleanup wait budget for the resources an existing session owns. */
export function resolveDaemonSessionTeardownTimeoutMs(session: SessionState): number {
  let timeoutMs = DAEMON_SESSION_TEARDOWN_TIMEOUT_MS;
  if (session.screenRecording) timeoutMs += SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS;
  if (isWebSession(session)) timeoutMs += WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS;
  return timeoutMs;
}
