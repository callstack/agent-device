import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { SessionStore } from '../session-store.ts';

// Bounds the daemon's own lifetime when nothing is using it. Each
// AGENT_DEVICE_STATE_DIR spawns a dedicated daemon that otherwise never exits
// on its own, so short-lived sandboxes (deleted codex/claude worktrees, one-off
// CLI invocations) leave orphaned daemon processes behind indefinitely -
// observed accumulating (10+) in production. A stale daemon left running this
// way also keeps holding its iOS runner lease, which blocks a fresh daemon for
// the same device (see runner-lease.ts stale-lease takeover).
//
// The window mirrors the iOS runner idle-stop default
// (AGENT_DEVICE_IOS_RUNNER_IDLE_STOP_MS, 5 minutes, see runner-session.ts):
// graceful daemon shutdown already hands off a healthy retained simulator
// runner for the next daemon to adopt (detachIosSimulatorRunnerSessionsForShutdown),
// so reaping the daemon process itself on the same timescale does not force a
// runner rebuild in the common case - it only pays the cheap daemon
// bootstrap (socket/HTTP listen) on the next command.
const DAEMON_IDLE_REAP_DEFAULT_MS = 5 * 60_000;

// AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS overrides the window; 0 disables idle
// reap and restores the pre-existing "runs until killed" behavior.
export function resolveDaemonIdleReapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DAEMON_IDLE_REAP_DEFAULT_MS;
}

export function hasOpenSessions(sessionStore: SessionStore): boolean {
  return sessionStore.toArray().length > 0;
}

// Recording lifecycle is session-scoped (session.recording), so this is
// currently implied by hasOpenSessions. Kept as an explicit, independently
// testable guard so a future recording path that outlives its session cannot
// silently lose this protection.
export function hasActiveRecording(sessionStore: SessionStore): boolean {
  return sessionStore.toArray().some((session) => Boolean(session.recording));
}

export function isDaemonIdle(params: {
  sessionStore: SessionStore;
  inFlightRequestCount: number;
}): boolean {
  if (params.inFlightRequestCount > 0) return false;
  if (hasOpenSessions(params.sessionStore)) return false;
  return !hasActiveRecording(params.sessionStore);
}

export type DaemonIdleReapController = {
  /**
   * Call whenever daemon activity changes (request start/end, session
   * open/close). Reschedules the pending reap when the daemon is currently
   * idle, or cancels it when it is not.
   */
  noteActivity: () => void;
  cancel: () => void;
  readonly idleMs: number;
};

export function createDaemonIdleReap(params: {
  sessionStore: SessionStore;
  getInFlightRequestCount: () => number;
  onIdleReap: () => void;
  env?: NodeJS.ProcessEnv;
}): DaemonIdleReapController {
  const idleMs = resolveDaemonIdleReapMs(params.env);
  let timer: NodeJS.Timeout | undefined;

  const isIdleNow = (): boolean =>
    isDaemonIdle({
      sessionStore: params.sessionStore,
      inFlightRequestCount: params.getInFlightRequestCount(),
    });

  const cancel = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    cancel();
    if (idleMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Re-check at fire time instead of trusting the scheduling snapshot: a
      // session open or new request must never lose a race against a
      // previously scheduled reap.
      if (!isIdleNow()) return;
      emitDiagnostic({ level: 'info', phase: 'daemon_idle_reap', data: { idleMs } });
      params.onIdleReap();
    }, idleMs);
    timer.unref?.();
  };

  const noteActivity = (): void => {
    if (isIdleNow()) schedule();
    else cancel();
  };

  return { noteActivity, cancel, idleMs };
}
