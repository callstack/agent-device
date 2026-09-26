import { AppError } from '@agent-device/kernel/errors';
import type { DeviceClaimClearOutcome } from './device/device-claims.ts';
import type { SessionState } from './session-state.ts';
import type { IdleSessionTombstone } from './session-idle-tombstone.ts';

/**
 * #2833: an opt-in inactivity deadline for a session holding a local device claim, off by default.
 *
 * Agents sharing one host routinely finish a workflow without running `close`, so the host-global
 * claim their session took stays live until that daemon stops; every other agent on the machine then
 * reads `DEVICE_IN_USE` and cannot tell an active session from an abandoned one. A remote lease
 * already answers this with an inactivity TTL (ADR 0007) because the remote daemon is authoritative
 * over it. A local claim has no such authority, so only the daemon that OWNS the session may end it:
 * this is that daemon expiring its own session, which is why it never crosses #1320's rule that a
 * verified live *foreign* owner is not reclaimed for looking idle. Nothing here reads or reconciles
 * another daemon's claim — `device release --stale` and the startup sweep stay the only paths that
 * touch a foreign claim, and both keep their fail-closed behavior.
 *
 * Scope is the sessions whose ownership this daemon can actually settle, and it is a rule rather
 * than a heuristic:
 *
 * - `deviceClaim` present — the host-global claim is the resource the issue is about, and a session
 *   with no claim is holding nothing another agent waits on.
 * - `lease` absent — a session with a remote lease is governed by that lease's own inactivity TTL,
 *   which is authoritative and already enforced at admission. Running two deadlines over one
 *   session would make the earlier one responsible for a device the other owns.
 *
 * Off unless `AGENT_DEVICE_SESSION_IDLE_TIMEOUT_MS` is a positive number, because a false expiry
 * tears down a live session, and on a shared host "idle" and "thinking" are indistinguishable.
 */
export const SESSION_IDLE_EXPIRY_ENV = 'AGENT_DEVICE_SESSION_IDLE_TIMEOUT_MS';

/** The typed reason naming why an absent session is absent. Keyed behavior, never message text. */
const SESSION_IDLE_EXPIRED_REASON = 'SESSION_IDLE_EXPIRED';

/** A marker lives long enough for the command that comes next, not for an unrelated future session. */
const IDLE_EXPIRY_TOMBSTONE_TTL_MS = 60 * 60_000;

/**
 * The inactivity window in force for this daemon, or `0` when the feature is off. Unset,
 * unparseable, and non-positive all mean off; `0` is the documented "run until closed".
 *
 * A positive value is never allowed to round down into off: `0.4` is an operator asking for the
 * shortest window the unit supports, not for the feature being disabled, and silently disabling a
 * feature someone just opted into is the worst possible reading of a typo.
 */
export function resolveSessionIdleExpiryMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[SESSION_IDLE_EXPIRY_ENV]?.trim();
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(1, Math.floor(parsed));
}

/**
 * The instant this session last did something that counts as using it: the end of the last command
 * admitted against it, or its own creation when nothing has finished since. `createdAt` is the base
 * so the exact abandonment this exists for — `open`, then silence — expires on its own.
 *
 * Measured from a command's END, matching what a lease does for admitted work (ADR 0007): one
 * command that outlives the window must not be the reason its own session is taken away mid-flight.
 */
export function lastActivityMs(session: SessionState): number {
  return session.lastActivityAtMs ?? session.createdAt;
}

/**
 * The sessions this daemon may expire for idleness: a claim to release, no remote lease owning the
 * session's ownership instead, and no capture running that this daemon itself started.
 *
 * The capture exclusion is the recording rule, generalized. `record`, `logs start`, `audio start`,
 * `perf start`, and `trace start` each stamp the session once and then go silent while the capture
 * runs, so a deadline measured from commands alone would call that idle and destroy evidence the
 * workflow is still collecting — the same evidence the daemon-process reap honors with
 * `hasActiveRecording`. It is narrower than that reap needs (a reapable daemon has no open session
 * left to hold) and exactly as wide as an expiring daemon must be, because here the session IS the
 * thing under the deadline. An abandoned capture is reclaimed by daemon exit and the startup orphan
 * reap, not here.
 */
export function isIdleExpirableSession(session: SessionState): boolean {
  return (
    session.deviceClaim !== undefined &&
    session.lease === undefined &&
    session.screenRecording === undefined &&
    session.appLog === undefined &&
    session.audioProbe === undefined &&
    session.perfCapture === undefined &&
    session.trace === undefined
  );
}

/** Whether the inactivity window has elapsed since this session was last used. */
export function idleDeadlineExceeded(
  session: SessionState,
  idleExpiryMs: number,
  now: number = Date.now(),
): boolean {
  if (idleExpiryMs <= 0) return false;
  return now - lastActivityMs(session) >= idleExpiryMs;
}

/**
 * The full expiry verdict for one session: expirable in kind AND past its deadline. This is the
 * predicate the reaper re-checks under the session's execution lock, so the eligibility rule and the
 * clock can never be applied by half at the moment that matters.
 */
export function isSessionIdleExpired(
  session: SessionState,
  idleExpiryMs: number,
  now: number = Date.now(),
): boolean {
  return isIdleExpirableSession(session) && idleDeadlineExceeded(session, idleExpiryMs, now);
}

/** The instant this session's deadline falls due, or `undefined` when nothing is armed. */
export function sessionIdleDeadlineMs(
  session: SessionState,
  idleExpiryMs: number,
): number | undefined {
  if (!isIdleExpirableSession(session) || idleExpiryMs <= 0) return undefined;
  return lastActivityMs(session) + idleExpiryMs;
}

/**
 * One expired session's claim result, classified the way `daemon stop` classifies claims: `deleted`
 * or `absent` means the claim is confirmed gone, and `ownership-changed` means another owner already
 * replaced it. A clear that could confirm nothing never reaches this record — it holds the expiry
 * back so the next pass retries — which is why there is no failure member here.
 */
export type SessionIdleExpiryOutcome = Readonly<{
  sessionName: string;
  idleExpiryMs: number;
  idleForMs: number;
  claim: DeviceClaimClearOutcome;
  deviceKey?: string;
}>;

export function buildIdleExpiryTombstone(
  sessionName: string,
  record: Readonly<{ expiredAtMs: number; idleExpiryMs: number; deviceKey?: string }>,
): IdleSessionTombstone {
  return {
    owner: sessionName,
    expiredAtMs: record.expiredAtMs,
    expiresAt: record.expiredAtMs + IDLE_EXPIRY_TOMBSTONE_TTL_MS,
    idleExpiryMs: record.idleExpiryMs,
    ...(record.deviceKey ? { deviceKey: record.deviceKey } : {}),
  };
}

/**
 * The answer a caller gets when it addresses a session an earlier expiry already settled: still
 * `SESSION_NOT_FOUND`, because the session genuinely is gone, but carrying the reason, the window,
 * and the device that was released instead of a bare "Run open first".
 */
export function sessionIdleExpiredError(
  sessionName: string,
  tombstone: IdleSessionTombstone,
  now: number = Date.now(),
): AppError {
  const sinceExpiredMs = Math.max(0, now - tombstone.expiredAtMs);
  return new AppError(
    'SESSION_NOT_FOUND',
    `Session "${tombstone.owner}" expired ${formatIdle(sinceExpiredMs)} ago for idleness (window ${formatIdle(tombstone.idleExpiryMs)}). Run open again to start a new session.`,
    {
      reason: SESSION_IDLE_EXPIRED_REASON,
      session: sessionName,
      idleExpiryMs: tombstone.idleExpiryMs,
      ...(tombstone.deviceKey ? { deviceKey: tombstone.deviceKey } : {}),
      hint: tombstone.deviceKey
        ? `Run open again to claim ${tombstone.deviceKey} and start a new session. Set ${SESSION_IDLE_EXPIRY_ENV}=0 to keep sessions open indefinitely.`
        : `Run open again to start a new session. Set ${SESSION_IDLE_EXPIRY_ENV}=0 to keep sessions open indefinitely.`,
    },
  );
}

/** Human-scale durations for the message; the exact milliseconds ride in `details`. */
function formatIdle(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  return `${Math.round(minutes / 60)}h`;
}
