import type { SessionState } from './types.ts';
import { isWebSession } from './web-session-names.ts';

const DAEMON_SESSION_TEARDOWN_TIMEOUT_MS = 5_000;
export const SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS = 11_000;
// Mirrors AGENT_BROWSER_TIMEOUT_MS in @agent-device/platform-web: the ceiling that
// module already places on one `agent-browser` CLI call, so the race below never gives up on the
// web-close step while the close it started is still running within its own enforced limit.
export const WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS = 30_000;
/**
 * Per-session teardown budget for daemon shutdown. The base budget covers ordinary resources; an
 * active durable recording or an open web session gets an additional owner-finalization budget so
 * the daemon cannot exit while its runtime handle is still producing the terminal media artifact,
 * or while agent-browser is still closing its Chrome fleet. The base portion remains available to
 * cleanup steps that follow recording finalization or the web close.
 */
export function resolveDaemonSessionTeardownTimeoutMs(
  session?: SessionState,
  reserveScreenRecording = false,
): number {
  let timeoutMs = DAEMON_SESSION_TEARDOWN_TIMEOUT_MS;
  if (session?.screenRecording || reserveScreenRecording)
    timeoutMs += SCREEN_RECORDING_SESSION_TEARDOWN_BUDGET_MS;
  if (session && isWebSession(session)) timeoutMs += WEB_BROWSER_SESSION_TEARDOWN_BUDGET_MS;
  return timeoutMs;
}
